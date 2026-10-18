import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { CostSummary } from '@fakl/protocol';

import type { AgentControl, AgentEventRouter } from './agents.js';
import type { FromChat, ToChat } from './chat-protocol.js';
import { moveToNewWindow } from './janelas.js';
import { findFiles } from './mesa.js';
import type { VozUi } from './voz.js';
import { attachTips } from './tour.js';
import { expandMentions } from './webview/mesa-model.js';

/**
 * Chat com os agentes na barra lateral secundária, no mesmo lugar e jeito do
 * chat do VS Code: escolhe o agente, conversa, vê ferramentas e responde
 * pedidos de permissão sem sair da conversa. Também abre numa janela própria,
 * para ficar em outro monitor (ADR 0034); as duas mostram a mesma conversa.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'fakl.chat';
  static readonly windowId = 'fakl.chatJanela';

  private view: vscode.WebviewView | undefined;
  /** O chat como editor, que vai para uma janela em outro monitor. */
  private window: vscode.WebviewPanel | undefined;
  private selected: string | undefined;
  private client: CoreClient | undefined;
  private usageTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agents: AgentControl,
    router: AgentEventRouter,
    private readonly voz: VozUi,
  ) {
    agents.isShowingInChat = (sessionId) =>
      (this.view?.visible === true || this.window?.visible === true) && this.selected === sessionId;
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      agents.onDidChangeSessions(() => {
        this.postSessions();
      }),
      agents.onDidPatch((patch) => {
        if (patch.sessionId === this.selected) this.post({ type: 'patch', ...patch });
      }),
      agents.onDidHydrate((sessionId) => {
        if (sessionId === this.selected) this.select(sessionId);
      }),
      agents.onDidChangeFiles((sessionId) => {
        if (sessionId === this.selected) void this.postChanges(sessionId);
      }),
      router.listen((event) => {
        if (event.topic === 'cost.update') this.scheduleUsage();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.postProfiles()),
      voz.onDidChangeStatus(() => {
        this.postVoz();
      }),
      vscode.commands.registerCommand('fakl.chat.open', async (arg?: unknown) => {
        const sessionId =
          arg && typeof arg === 'object' && 'sessionId' in arg ? String(arg.sessionId) : undefined;
        await this.focus();
        this.select(sessionId);
      }),
      vscode.commands.registerCommand('fakl.janela.chat', async () => {
        await moveToNewWindow(this.showWindow());
      }),
      vscode.window.registerWebviewPanelSerializer(ChatViewProvider.windowId, {
        deserializeWebviewPanel: (panel) => {
          this.adopt(panel);
          return Promise.resolve();
        },
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.usageTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  connected(client: CoreClient): void {
    this.client = client;
    this.scheduleUsage(0);
  }

  disconnected(): void {
    this.client = undefined;
  }

  /** Gasto do dia por provedor; agrupa rajadas de `cost.update` num pedido só. */
  private scheduleUsage(delay = 1000): void {
    if (this.usageTimer) return;
    this.usageTimer = setTimeout(() => {
      this.usageTimer = undefined;
      const client = this.client;
      if (!client || !this.hasHost) return;
      void client
        .request<CostSummary>('costs.summary')
        .then((summary) => {
          this.post({ type: 'usage', summary });
        })
        .catch(() => undefined);
    }, delay);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    view.webview.html = this.html(view.webview, this.media);
    attachTips(view, 'chat');
    view.webview.onDidReceiveMessage((message: FromChat) => void this.receive(message));
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private get hasHost(): boolean {
    return this.view !== undefined || this.window !== undefined;
  }

  private get media(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'dist', 'chat');
  }

  /** Mostra o chat onde ele estiver: na janela própria, se existir, ou na barra. */
  private async focus(): Promise<void> {
    if (this.window) this.window.reveal(undefined, false);
    else await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  private showWindow(): vscode.WebviewPanel {
    if (this.window) {
      this.window.reveal();
      return this.window;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.windowId,
      l10n.t('Agents'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.media] },
    );
    this.adopt(panel);
    return panel;
  }

  /** Liga a janela do chat, nova ou restaurada ao reabrir a IDE. */
  private adopt(panel: vscode.WebviewPanel): void {
    const previous = this.window;
    this.window = panel;
    previous?.dispose();
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'agents.svg');
    panel.webview.html = this.html(panel.webview, this.media);
    attachTips(panel, 'chat');
    panel.webview.onDidReceiveMessage((message: FromChat) => void this.receive(message));
    panel.onDidDispose(() => {
      if (this.window === panel) this.window = undefined;
    });
  }

  private select(sessionId: string | undefined): void {
    this.selected = sessionId && this.agents.session(sessionId) ? sessionId : undefined;
    this.postSessions();
    if (this.selected) {
      this.post({
        type: 'transcript',
        sessionId: this.selected,
        items: this.agents.transcript(this.selected),
      });
      void this.postChanges(this.selected);
    }
  }

  private async postChanges(sessionId: string): Promise<void> {
    try {
      const diff = await this.agents.changes(sessionId);
      this.post(
        diff
          ? { type: 'changes', sessionId, files: diff.files, branch: diff.branch }
          : { type: 'changes', sessionId },
      );
    } catch {
      // O agente ainda está criando o worktree; a próxima mudança atualiza.
    }
  }

  private async receive(message: FromChat): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.postVoz();
          await this.postProfiles();
          this.select(this.selected);
          this.scheduleUsage(0);
          break;
        case 'select':
          this.select(message.sessionId);
          break;
        case 'refreshProfiles':
          await this.postProfiles();
          break;
        case 'install': {
          const profile = (await this.agents.detect()).find((p) => p.id === message.profileId);
          const install = profile?.availability.install;
          if (profile && install) await this.agents.install(profile.nome, install);
          break;
        }
        case 'send': {
          let sessionId = message.sessionId;
          if (!sessionId) {
            if (!message.profileId) throw new Error(l10n.t('Choose an agent.'));
            sessionId = await this.agents.start(
              message.profileId,
              message.worktree === true,
              message.permissions,
            );
            this.select(sessionId);
          }
          await this.agents.send(sessionId, this.expand(message.text, sessionId), message.text);
          break;
        }
        case 'permission':
          await this.agents.respondPermission(message.sessionId, message.id, message.allow);
          break;
        case 'setOption':
          await this.agents.setOption(message.sessionId, message.id, message.value);
          break;
        case 'setPermissions':
          await this.agents.setPermissions(message.sessionId, message.permissions);
          break;
        case 'setAutoResume':
          if (!this.client) throw new Error(l10n.t('FaKL Core is not responding.'));
          await this.client.request('agents.setAutoResume', {
            sessionId: message.sessionId,
            automatica: message.automatica,
          });
          break;
        case 'openDiff':
          await this.agents.openDiff(message.sessionId, message.path);
          break;
        case 'applyFiles':
          await this.agents.applyFiles(message.sessionId, message.paths);
          break;
        case 'rejectFiles':
          await this.agents.rejectFiles(message.sessionId, message.paths);
          break;
        case 'findFiles': {
          const active = vscode.window.activeTextEditor?.document.uri;
          this.post({
            type: 'files',
            requestId: message.requestId,
            files: await findFiles(message.query),
            ...(active?.scheme === 'file'
              ? { active: vscode.workspace.asRelativePath(active, false) }
              : {}),
          });
          break;
        }
        case 'openMesa':
          await vscode.commands.executeCommand(
            'fakl.mesa.open',
            message.sessionId ? { sessionId: message.sessionId } : undefined,
          );
          break;
        case 'pause':
        case 'resume':
        case 'stop':
          await this.agents.control(message.type, message.sessionId);
          break;
        case 'vozTranscrever':
        case 'vozConfigurar':
          await this.voz.handle(message, (reply) => {
            this.post(reply);
          });
          break;
      }
    } catch (error) {
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  /** @Nome de outro agente leva a última resposta dele junto com a mensagem. */
  private expand(text: string, except: string): string {
    if (!text.includes('@')) return text;
    const answers = new Map<string, string>();
    for (const session of this.agents.sessions()) {
      if (session.sessionId === except) continue;
      const last = this.agents.transcript(session.sessionId).findLast((i) => i.kind === 'agent');
      if (last?.kind === 'agent') answers.set(session.nome, last.text);
    }
    return expandMentions(text, answers);
  }

  /** Conversa aberta no chat, que recebe os pedidos por voz como mensagem. */
  activeSession(): string | undefined {
    return this.hasHost && this.selected && this.agents.session(this.selected)
      ? this.selected
      : undefined;
  }

  /** Abre um agente novo com o perfil e manda o primeiro pedido, com o chat em foco. */
  async startAndSend(
    profileId: string,
    text: string,
    worktree: boolean,
    pasta?: string,
  ): Promise<void> {
    await this.focus();
    const sessionId = await this.agents.start(profileId, worktree, undefined, pasta);
    this.select(sessionId);
    await this.agents.send(sessionId, this.expand(text, sessionId), text);
  }

  /** Manda uma mensagem a uma conversa existente e a mostra no chat. */
  async sendTo(sessionId: string, text: string): Promise<void> {
    await this.agents.send(sessionId, this.expand(text, sessionId), text);
    await this.focus();
    this.select(sessionId);
  }

  private postVoz(): void {
    const status = this.voz.status;
    this.post(status ? { type: 'vozStatus', status } : { type: 'vozStatus' });
  }

  /** Os perfis mudaram nos arquivos; o seletor do chat mostra os novos. */
  refreshProfiles(): void {
    void this.postProfiles();
  }

  private async postProfiles(): Promise<void> {
    if (!this.hasHost) return;
    const profiles = await this.agents.detect(true);
    this.post({
      type: 'profiles',
      profiles,
      // Sem pasta, o agente usa a pasta padrão; criar nunca fica bloqueado.
      hasFolder: true,
    });
  }

  private postSessions(): void {
    if (this.selected && !this.agents.session(this.selected)) this.selected = undefined;
    this.post({
      type: 'sessions',
      sessions: this.agents.sessions(),
      ...(this.selected ? { selected: this.selected } : {}),
    });
  }

  private post(message: ToChat): void {
    void this.view?.webview.postMessage(message);
    void this.window?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>${l10n.t('Agents')}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
