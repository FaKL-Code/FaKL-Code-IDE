import { randomBytes } from 'node:crypto';

import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { CostSummary, Run, Task } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentControl, AgentEventRouter } from './agents.js';
import type { ExternalSessionsFeed } from './externas.js';
import { MESA_COMMANDS, type FromMesa, type ToMesa } from './mesa-protocol.js';
import { moveToNewWindow } from './janelas.js';
import type { VozUi } from './voz.js';
import { parseLayout, portalUrl, type MesaRole } from './webview/mesa-model.js';

const LAYOUT_KEY = 'fakl.mesa.layout';

/**
 * Mesa (ADR 0017): o canvas infinito onde cada agente é um cartão com a
 * conversa ao vivo, ligado por cabos ao maestro que o chamou, agrupado nos
 * andares (worktrees) e com as ações à mão. Usa o mesmo estado do chat.
 */
export class MesaUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private client: CoreClient | undefined;
  private roles: MesaRole[] = [];
  private rolesTimer: NodeJS.Timeout | undefined;
  private usageTimer: NodeJS.Timeout | undefined;
  private watching: vscode.Disposable | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly agents: AgentControl,
    router: AgentEventRouter,
    private readonly voz: VozUi,
    private readonly externas: ExternalSessionsFeed,
  ) {
    this.disposables.push(
      externas.onDidChange(() => {
        this.postExternas();
      }),
      voz.onDidChangeStatus(() => {
        this.postVoz();
      }),
      vscode.commands.registerCommand('fakl.mesa.open', (arg?: unknown) => {
        this.show();
        const sessionId =
          arg && typeof arg === 'object' && 'sessionId' in arg ? String(arg.sessionId) : undefined;
        if (sessionId) this.post({ type: 'focus', sessionId });
      }),
      vscode.commands.registerCommand('fakl.janela.mesa', async () => {
        await moveToNewWindow(this.show());
      }),
      // A Mesa numa janela de outro monitor volta lá quando a IDE reabre.
      vscode.window.registerWebviewPanelSerializer('fakl.mesa', {
        deserializeWebviewPanel: (panel) => {
          this.adopt(panel);
          return Promise.resolve();
        },
      }),
      agents.onDidChangeSessions(() => {
        this.postSessions();
      }),
      agents.onDidPatch((patch) => {
        this.post({ type: 'patch', ...patch });
      }),
      agents.onDidHydrate((sessionId) => {
        this.post({
          type: 'transcript',
          sessionId,
          items: this.agents.transcript(sessionId),
        });
      }),
      agents.onDidChangeFiles((sessionId) => void this.postChanges(sessionId)),
      router.listen((event) => {
        if (event.topic.startsWith('run.')) this.scheduleRoles();
        if (event.topic === 'cost.update') this.scheduleUsage();
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.rolesTimer);
    clearTimeout(this.usageTimer);
    this.watching?.dispose();
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  connected(client: CoreClient): void {
    this.client = client;
    this.scheduleRoles();
    this.scheduleUsage();
    void this.postProfiles();
  }

  disconnected(): void {
    this.client = undefined;
    this.post({ type: 'offline' });
  }

  /** Abre a Mesa ao iniciar, se o usuário não desligou. */
  openOnStartup(): void {
    const enabled = vscode.workspace
      .getConfiguration('fakl')
      .get<boolean>('mesa.abrirAoIniciar', true);
    if (enabled && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) this.show();
  }

  private show(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal();
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel(
      'fakl.mesa',
      l10n.t('Desk'),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        // A Mesa guarda posições, zoom e rascunhos dos cartões em memória.
        retainContextWhenHidden: true,
        localResourceRoots: [this.media],
      },
    );
    this.adopt(panel);
    return panel;
  }

  private get media(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'mesa');
  }

  /** Liga um painel novo ou restaurado; um restaurado vence o aberto ao iniciar. */
  private adopt(panel: vscode.WebviewPanel): void {
    const previous = this.panel;
    this.panel = panel;
    previous?.dispose();
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.media] };
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agents.svg');
    panel.webview.html = this.html(panel.webview, this.media);
    panel.webview.onDidReceiveMessage((message: FromMesa) => void this.receive(message));
    this.watching?.dispose();
    this.watching = this.externas.watch();
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.watching?.dispose();
      this.watching = undefined;
    });
  }

  private async receive(message: FromMesa): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.post({
            type: 'init',
            layout: parseLayout(this.context.workspaceState.get(LAYOUT_KEY)),
            // Sem pasta, o agente usa a pasta padrão; criar nunca fica bloqueado.
            hasFolder: true,
            profiles: await this.agents.detect(true),
          });
          this.postSessions();
          this.postExternas();
          this.postVoz();
          this.scheduleUsage();
          for (const session of this.agents.sessions()) {
            this.post({
              type: 'transcript',
              sessionId: session.sessionId,
              items: this.agents.transcript(session.sessionId),
            });
            void this.postChanges(session.sessionId);
          }
          return;
        case 'saveLayout':
          await this.context.workspaceState.update(LAYOUT_KEY, message.layout);
          return;
        case 'start': {
          const sessionId = await this.agents.start(
            message.profileId,
            message.worktree,
            message.permissions,
          );
          this.post({
            type: 'started',
            sessionId,
            ...(message.at ? { at: message.at } : {}),
          });
          return;
        }
        case 'send':
          await this.agents.send(message.sessionId, message.text, message.shown);
          return;
        case 'permission':
          await this.agents.respondPermission(message.sessionId, message.id, message.allow);
          return;
        case 'setOption':
          await this.agents.setOption(message.sessionId, message.id, message.value);
          return;
        case 'setPermissions':
          await this.agents.setPermissions(message.sessionId, message.permissions);
          return;
        case 'pause':
        case 'resume':
        case 'stop':
          await this.agents.control(message.type, message.sessionId);
          return;
        case 'changes':
          await this.postChanges(message.sessionId);
          return;
        case 'openDiff':
          await this.agents.openDiff(message.sessionId, message.path);
          return;
        case 'applyFiles':
          await this.agents.applyFiles(message.sessionId, message.paths);
          return;
        case 'rejectFiles':
          await this.agents.rejectFiles(message.sessionId, message.paths);
          return;
        case 'openChat':
          await vscode.commands.executeCommand('fakl.chat.open', { sessionId: message.sessionId });
          return;
        case 'terminal':
          await vscode.commands.executeCommand('fakl.agents.terminal', {
            sessionId: message.sessionId,
          });
          return;
        case 'log':
          await vscode.commands.executeCommand('fakl.agents.showLog', {
            sessionId: message.sessionId,
          });
          return;
        case 'externasAtivar':
          await vscode.commands.executeCommand('fakl.externas.ativar');
          return;
        case 'externasAbrir':
          await this.externas.open(message.id);
          return;
        case 'clearFinished':
          await vscode.commands.executeCommand('fakl.agents.clearFinished');
          return;
        case 'command':
          await vscode.commands.executeCommand(MESA_COMMANDS[message.command]);
          return;
        case 'findFiles':
          this.post({
            type: 'files',
            requestId: message.requestId,
            files: await findFiles(message.query),
          });
          return;
        case 'openExternal': {
          const url = portalUrl(message.url);
          if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
          return;
        }
        case 'vozTranscrever':
        case 'vozConfigurar':
          await this.voz.handle(message, (reply) => {
            this.post(reply);
          });
          return;
      }
    } catch (error) {
      this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
  }

  private postVoz(): void {
    const status = this.voz.status;
    this.post(status ? { type: 'vozStatus', status } : { type: 'vozStatus' });
  }

  private postExternas(): void {
    this.post({ type: 'externas', ...this.externas.state });
  }

  private postSessions(): void {
    this.post({ type: 'sessions', sessions: this.agents.sessions(), roles: this.roles });
  }

  private async postProfiles(): Promise<void> {
    if (!this.panel) return;
    this.post({ type: 'profiles', profiles: await this.agents.detect(true) });
  }

  private async postChanges(sessionId: string): Promise<void> {
    if (!this.panel) return;
    try {
      const diff = await this.agents.changes(sessionId);
      this.post(
        diff
          ? { type: 'changes', sessionId, files: diff.files, branch: diff.branch }
          : { type: 'changes', sessionId },
      );
    } catch {
      // Worktree ainda sendo criado; a próxima mudança atualiza.
    }
  }

  private scheduleUsage(): void {
    if (this.usageTimer) return;
    this.usageTimer = setTimeout(() => {
      this.usageTimer = undefined;
      const client = this.client;
      if (!client || !this.panel) return;
      void client
        .request<CostSummary>('costs.summary')
        .then((summary) => {
          this.post({ type: 'usage', summary });
        })
        .catch(() => undefined);
    }, 1000);
  }

  /** Papéis e pais das sessões das execuções, para os cabos maestro → subagentes. */
  private scheduleRoles(): void {
    clearTimeout(this.rolesTimer);
    this.rolesTimer = setTimeout(() => void this.loadRoles(), 300);
  }

  private async loadRoles(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const tasks = await client.request<Task[]>('tasks.list');
      const details = await Promise.all(
        tasks
          .filter((task) => task.runs.length > 0)
          .map(async (task) => ({
            task,
            detail: await client.request<{ runs: Run[] }>('tasks.get', { taskId: task.id }),
          })),
      );
      this.roles = details.flatMap(({ task, detail }) =>
        detail.runs.flatMap((run) =>
          run.agentes.map((agent) => ({
            sessionId: agent.sessionId,
            papel: agent.papel,
            tarefa: task.titulo,
            ...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
          })),
        ),
      );
      this.postSessions();
    } catch {
      // Core reiniciando; a próxima execução recarrega.
    }
  }

  private post(message: ToMesa): void {
    void this.panel?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'mesa.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'mesa.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      // Prévias (portais) do app rodando na máquina ou de um endereço https.
      'frame-src http://localhost:* http://127.0.0.1:* https:',
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>${l10n.t('Desk')}</title>
</head>
<body>
<div id="mesa"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}

/** Até 30 arquivos da pasta cujo caminho contém `query`, sem node_modules e afins. */
export async function findFiles(query: string): Promise<string[]> {
  const clean = query.replace(/[{}[\]*?!]/g, '');
  const uris = await vscode.workspace.findFiles(
    clean ? `**/*${clean}*` : '**/*',
    '{**/node_modules/**,**/.git/**,**/dist/**,**/.build/**,**/out/**}',
    30,
  );
  return uris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
}
