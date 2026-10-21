import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { commandLine, resumeSuggestion, shellFlavor } from '@fakl/agents';
import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type {
  AgentApplyResult,
  AgentDiffResult,
  AgentFileContentResult,
  AgentOutputEventData,
  AgentPromptEventData,
  AgentPermissionEventData,
  AgentProfileAvailability,
  AgentSessionInfo,
  AgentStartResult,
  AgentStateEventData,
  AgentToolEventData,
  AgentTerminalLinesParams,
  AgentTranscriptResult,
  ClaudeAccountSlot,
  FaklEvent,
  PermissionPolicyName,
  TerminalHostCommand,
} from '@fakl/protocol';
import { isFinalAgentState } from '@fakl/protocol';
import * as vscode from 'vscode';

import {
  actionGroup,
  AgentBoard,
  describe,
  formatUsage,
  STATE_ICONS,
  stateLabel,
} from './board.js';
import { AgentLiveTerminals } from './agent-terminal.js';
import { naPasta, pastasLocais } from './escopo.js';
import { TerminalAgentHost } from './terminal-agent-host.js';
import { firstLocalFolder, remoteRoots } from './ssh-workspace.js';
import { permissionLine } from './webview/chat-model.js';
import { Transcript, type ChatItem } from '@fakl/conversa';

/** Eventos do Core por sessão de agente (o `subject` do evento). */
/** Pasta dos agentes quando a IDE está sem pasta aberta: `~/FaKL/agentes`. */
async function defaultWorkFolder(): Promise<string> {
  const folder = join(homedir(), 'FaKL', 'agentes');
  await mkdir(folder, { recursive: true });
  return folder;
}

export class AgentEventRouter {
  private readonly listeners = new Set<(event: FaklEvent) => void>();
  private readonly terminalListeners = new Set<(params: AgentTerminalLinesParams) => void>();
  private readonly hostListeners = new Set<(command: TerminalHostCommand) => void>();

  /** Comando do Core ao hospedeiro de terminais (agente de terminal, ADR 0047). */
  dispatchHost(command: TerminalHostCommand): void {
    for (const listener of this.hostListeners) listener(command);
  }

  listenHost(listener: (command: TerminalHostCommand) => void): vscode.Disposable {
    this.hostListeners.add(listener);
    return new vscode.Disposable(() => this.hostListeners.delete(listener));
  }

  /** Linhas novas de um terminal anexado (`agents.terminal.lines`). */
  dispatchTerminal(params: AgentTerminalLinesParams): void {
    for (const listener of this.terminalListeners) listener(params);
  }

  listenTerminal(listener: (params: AgentTerminalLinesParams) => void): vscode.Disposable {
    this.terminalListeners.add(listener);
    return new vscode.Disposable(() => this.terminalListeners.delete(listener));
  }

  dispatch(event: FaklEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Todos os eventos de agente; sem `sessionId`, de todas as sessões. */
  listen(listener: (event: FaklEvent) => void, sessionId?: string): vscode.Disposable {
    const wrapped = sessionId
      ? (event: FaklEvent) => {
          if (event.subject === sessionId) listener(event);
        }
      : listener;
    this.listeners.add(wrapped);
    return new vscode.Disposable(() => this.listeners.delete(wrapped));
  }
}

/** Esquema dos dois lados do diff de um agente: `/<sessão>/<base|agente>/<caminho>`. */
const AGENT_SCHEME = 'fakl-agent';

const BUSY = new Set(['pensando', 'executando', 'aguardando-permissão']);

/** Situação de instalação de um perfil; em pt-BR, o próprio valor do protocolo. */
function availabilityLabel(status: AgentProfileAvailability['availability']['status']): string {
  return status === 'pronto' ? l10n.t('ready') : l10n.t('not installed');
}

/** Um painel de saída por sessão, com tudo o que o agente disse e fez. */
class SessionLogs implements vscode.Disposable {
  private readonly channels = new Map<string, vscode.OutputChannel>();

  constructor(private readonly board: AgentBoard) {}

  channel(sessionId: string): vscode.OutputChannel {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      const nome = this.board.get(sessionId)?.nome ?? l10n.t('agent');
      channel = vscode.window.createOutputChannel(`FaKL: ${nome} (${sessionId.slice(-6)})`);
      this.channels.set(sessionId, channel);
    }
    return channel;
  }

  write(event: FaklEvent): void {
    const out = (): vscode.OutputChannel => this.channel(event.subject);
    switch (event.topic) {
      case 'agent.prompt':
        out().appendLine(`\n\n> ${(event.data as AgentPromptEventData).text}\n`);
        break;
      case 'agent.output': {
        const data = event.data as AgentOutputEventData;
        if (data.kind === 'message') out().append(data.text);
        else if (data.kind === 'error') out().appendLine(`\n✖ ${data.text}`);
        break;
      }
      case 'agent.tool': {
        const data = event.data as AgentToolEventData;
        if (data.title)
          out().appendLine(`\n▸ ${data.title}${data.status ? ` (${data.status})` : ''}`);
        break;
      }
      case 'agent.state': {
        const data = event.data as AgentStateEventData;
        if (!BUSY.has(data.state) && BUSY.has(data.previous)) {
          const usage = this.board.get(event.subject)?.usage;
          if (usage) out().appendLine(`\n— ${formatUsage(usage)}`);
        }
        if (data.state === 'pausado' || data.state === 'falhou' || data.state === 'parado') {
          out().appendLine(`\n[${stateLabel(data.state)}${data.reason ? `: ${data.reason}` : ''}]`);
        }
        break;
      }
      default:
        break;
    }
  }

  forget(sessionId: string): void {
    this.channels.get(sessionId)?.dispose();
    this.channels.delete(sessionId);
  }

  dispose(): void {
    for (const channel of this.channels.values()) channel.dispose();
    this.channels.clear();
  }
}

/** Árvore de agentes da mesa de controle (RF-106). */
class AgentTreeProvider implements vscode.TreeDataProvider<AgentSessionInfo> {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly board: AgentBoard) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(element?: AgentSessionInfo): AgentSessionInfo[] {
    return element ? [] : this.board.list();
  }

  getTreeItem(session: AgentSessionInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(session.nome, vscode.TreeItemCollapsibleState.None);
    item.id = session.sessionId;
    item.description = describe(session);
    item.iconPath = new vscode.ThemeIcon(STATE_ICONS[session.state]);
    item.contextValue = `fakl.agent.${actionGroup(session.state)}`;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${session.nome}**: ${stateLabel(session.state)}\n\n`);
    tooltip.appendMarkdown(`${l10n.t('Folder: {0}', `\`${session.cwd}\``)}\n\n`);
    if (session.worktree) {
      tooltip.appendMarkdown(`${l10n.t('Branch: {0}', `\`${session.worktree.branch}\``)}\n\n`);
    }
    tooltip.appendMarkdown(l10n.t('Usage: {0}', formatUsage(session.usage)));
    const turno = session.usage.turno;
    if (turno && turno.passos > 0) {
      const gasto = l10n.t(
        'This turn: {0} tool calls, about {1} input tokens',
        String(turno.passos),
        turno.entrada.toLocaleString(),
      );
      tooltip.appendMarkdown(`

${gasto}`);
    }
    item.tooltip = tooltip;
    item.command = {
      command: 'fakl.chat.open',
      title: l10n.t('Open in chat'),
      arguments: [session],
    };
    return item;
  }
}

export interface TranscriptPatch {
  readonly sessionId: string;
  readonly index: number;
  readonly item: ChatItem;
}

/**
 * Estado dos agentes na IDE: a mesa de controle (árvore), a conversa de cada
 * sessão, os logs e as ações. O chat da barra lateral secundária usa esta
 * mesma classe.
 */
export class AgentControl implements vscode.Disposable {
  private readonly board = new AgentBoard((session) =>
    naPasta(session.pastaOrigem ?? session.cwd, pastasLocais(vscode.workspace.workspaceFolders)),
  );
  private readonly logs = new SessionLogs(this.board);
  private readonly liveTerminals = new AgentLiveTerminals();
  /** Terminais reais dos agentes de terminal (ADR 0047). */
  private readonly terminalHost = new TerminalAgentHost(vscode.window);
  private readonly tree = new AgentTreeProvider(this.board);
  private readonly transcripts = new Map<string, Transcript>();
  private readonly view: vscode.TreeView<AgentSessionInfo>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sessionsChanged = new vscode.EventEmitter<void>();
  private readonly patched = new vscode.EventEmitter<TranscriptPatch>();
  private readonly filesChanged = new vscode.EventEmitter<string>();
  private readonly hydrated = new vscode.EventEmitter<string>();
  private readonly fileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reloading: Promise<void> | undefined;
  private pending: FaklEvent[] | undefined;
  private client: CoreClient | undefined;

  /** A lista de sessões, um estado ou um custo mudou. */
  readonly onDidChangeSessions = this.sessionsChanged.event;
  /** Um item da conversa de uma sessão mudou ou foi acrescentado. */
  readonly onDidPatch = this.patched.event;
  /** Os arquivos que o agente mudou podem ter mudado (fim de turno, ferramenta concluída). */
  readonly onDidChangeFiles = this.filesChanged.event;
  /** A conversa de uma sessão reidratada do disco chegou do Core. */
  readonly onDidHydrate = this.hydrated.event;
  /**
   * O chat diz se está mostrando a sessão; nesse caso os pedidos de
   * permissão aparecem só nele, sem notificação.
   */
  isShowingInChat: (sessionId: string) => boolean = () => false;
  /** Conta do Claude de um agente novo; sem escolha, o Core usa a conta ativa (ADR 0021). */
  pickClaudeAccount: (profileId: string) => Promise<ClaudeAccountSlot | undefined> = () =>
    Promise.resolve(undefined);

  constructor(
    private readonly getClient: () => Promise<CoreClient | undefined>,
    router: AgentEventRouter,
  ) {
    this.view = vscode.window.createTreeView('fakl.agents', {
      treeDataProvider: this.tree,
      showCollapseAll: false,
    });
    this.disposables.push(
      this.view,
      this.logs,
      this.liveTerminals,
      {
        dispose: () => {
          this.terminalHost.dispose();
        },
      },
      this.sessionsChanged,
      this.patched,
      this.filesChanged,
      this.hydrated,
      vscode.workspace.registerTextDocumentContentProvider(AGENT_SCHEME, {
        provideTextDocumentContent: (uri) => this.agentFile(uri),
      }),
      router.listen((event) => {
        this.onEvent(event);
      }),
      router.listenTerminal((params) => {
        this.liveTerminals.onLines(params);
      }),
      router.listenHost((command) => {
        this.terminalHost.onCommand(command);
      }),
    );
    this.registerCommands();
    this.updateTitle();
  }

  /** Chamado a cada conexão com o Core, inclusive depois de ele reiniciar. */
  connected(client: CoreClient): void {
    this.client = client;
    this.liveTerminals.connected(client);
    this.terminalHost.connected(client);
    void this.reload();
  }

  disconnected(): void {
    this.client = undefined;
    this.liveTerminals.disconnected();
    this.terminalHost.disconnected();
  }

  dispose(): void {
    for (const timer of this.fileTimers.values()) clearTimeout(timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  sessions(): AgentSessionInfo[] {
    return this.board.list();
  }

  session(sessionId: string): AgentSessionInfo | undefined {
    return this.board.get(sessionId);
  }

  transcript(sessionId: string): readonly ChatItem[] {
    return this.transcriptFor(sessionId).items;
  }

  /**
   * Abre um terminal na pasta do agente com o comando que retoma a MESMA conversa
   * na CLI do provedor. O texto abre editável: só `claude --resume` e `gemini --resume`
   * foram conferidos com `--help`; o do Codex pode precisar de ajuste.
   */
  private async continueInTerminal(session: AgentSessionInfo): Promise<void> {
    const suggestion = resumeSuggestion(session.provedor, session.sessaoDoAgente);
    const shell = shellFlavor(vscode.env.shell, process.platform);
    const initial = suggestion ? commandLine(suggestion.command, suggestion.args, shell) : '';
    const typed = await vscode.window.showInputBox({
      title: l10n.t('Continue in the terminal'),
      prompt:
        suggestion && !suggestion.confirmed
          ? l10n.t(
              'Command that resumes this conversation in the CLI. It was not verified for this CLI: check it before running.',
            )
          : l10n.t('Command that resumes this conversation in the CLI. Edit it if needed.'),
      value: initial,
      ignoreFocusOut: true,
    });
    const command = typed?.trim();
    if (!command) return;
    if (!isFinalAgentState(session.state)) {
      const stop = l10n.t('Stop the agent and continue');
      const keep = l10n.t('Continue without stopping');
      const choice = await vscode.window.showWarningMessage(
        l10n.t(
          'The agent is still running in the IDE. Two programs on the same conversation can overwrite each other.',
        ),
        { modal: true },
        stop,
        keep,
      );
      if (!choice) return;
      if (choice === stop) {
        await vscode.commands.executeCommand('fakl.agents.stop', session);
      }
    }
    const terminal = vscode.window.createTerminal({
      name: l10n.t('Continue: {0} ({1})', session.nome, session.sessionId.slice(-6)),
      cwd: session.worktree?.path ?? session.cwd,
      iconPath: new vscode.ThemeIcon('terminal'),
    });
    terminal.show();
    terminal.sendText(command, true);
  }

  /** Chamado quando o Core não consegue iniciar um agente; o erro continua indo ao chamador. */
  onStartFailure: ((profileId: string, error: unknown) => void) | undefined;

  /** Perfis e se estão instalados; `quiet` não avisa quando o Core não responde. */
  async detect(quiet = false): Promise<AgentProfileAvailability[]> {
    const client = quiet ? await this.getClient() : await this.requireClient();
    return client ? client.request<AgentProfileAvailability[]>('agents.detect') : [];
  }

  /**
   * Inicia um agente na `pasta` dada ou, sem ela, na primeira pasta aberta. Sem
   * `permissions`, vale o modo do perfil ou do config.yaml. Devolve o id da sessão.
   */
  async start(
    profileId: string,
    worktree: boolean,
    permissions?: PermissionPolicyName,
    pasta?: string,
  ): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    // A pasta local do agente (e do worktree) é a primeira `file://`, não só a [0]:
    // com um servidor SSH na frente, o projeto local continua sendo o dele.
    const opened = pasta ?? firstLocalFolder(folders)?.uri.fsPath;
    // Raízes remotas (`fakl-ssh://`) vão no prompt; o agente chega nelas pelas ferramentas ssh_*.
    const remotas = remoteRoots(folders);
    // Sem pasta local aberta, o agente trabalha numa pasta padrão (dito no aviso abaixo).
    const cwd = opened ?? (await defaultWorkFolder());
    const client = await this.requireClient();
    if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
    const contaClaude = await this.pickClaudeAccount(profileId);
    const started = await client
      .request<AgentStartResult>('agents.start', {
        profileId,
        cwd,
        ...(contaClaude ? { contaClaude } : {}),
        ...(permissions ? { permissions } : {}),
        worktree,
        ...(remotas.length > 0 ? { remotas } : {}),
      })
      .catch((error: unknown) => {
        this.onStartFailure?.(profileId, error);
        throw error;
      });
    await this.reload();
    const remoto =
      remotas.length > 0
        ? ` ${l10n.t(
            'Servers in the workspace, reached through the ssh_* tools: {0}.',
            remotas.map((r) => `${r.host}:${r.caminho}`).join(', '),
          )}`
        : '';
    const where =
      (started.worktree
        ? l10n.t(
            'Working in {0}, on branch {1}. When it stops, the work stays committed on that branch.',
            started.worktree.path,
            started.worktree.branch,
          )
        : !opened
          ? l10n.t(
              'No local folder is open in the IDE, so the agent works in {0}. Open a project folder for it to work on.',
              cwd,
            )
          : worktree
            ? l10n.t(
                'Working directly in {0}, without a worktree: the folder is not a git repository with commits.',
                cwd,
              )
            : l10n.t('Working directly in {0}.', cwd)) + remoto;
    this.logs.channel(started.sessionId).appendLine(where);
    this.notify(started.sessionId, this.transcriptFor(started.sessionId).note(where));
    return started.sessionId;
  }

  /**
   * Manda a mensagem; ela entra na conversa e no log quando o Core devolve o
   * `agent.prompt`, como as mandadas pelo celular. `exibir` é o que a conversa
   * mostra quando o texto enviado leva anexos.
   */
  async send(sessionId: string, text: string, exibir?: string): Promise<void> {
    const client = await this.requireClient();
    if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
    try {
      await client.request('agents.send', {
        sessionId,
        message: text,
        ...(exibir && exibir !== text ? { exibir } : {}),
      });
    } catch (error) {
      // O campo já foi limpo: o texto fica na conversa para não se perder.
      const transcript = this.transcriptFor(sessionId);
      this.notify(sessionId, transcript.addUser(exibir ?? text));
      const reason = error instanceof Error ? error.message : String(error);
      this.notify(sessionId, transcript.note(l10n.t('Message not sent: {0}', reason)));
      throw error;
    }
  }

  async respondPermission(sessionId: string, id: string, allow: boolean): Promise<void> {
    const client = await this.requireClient();
    if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
    await client.request('agents.permission', { sessionId, id, allow });
    this.notify(sessionId, this.transcriptFor(sessionId).answer(id, allow));
  }

  /** Troca uma opção da sessão, como o modelo ou o raciocínio. */
  async setOption(sessionId: string, id: string, value: string | boolean): Promise<void> {
    const client = await this.requireClient();
    if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
    await client.request('agents.setOption', { sessionId, id, value });
  }

  async setPermissions(sessionId: string, permissions: PermissionPolicyName): Promise<void> {
    const client = await this.requireClient();
    if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
    await client.request('agents.setPermissions', { sessionId, permissions });
  }

  /** Arquivos que o agente mudou; `undefined` quando ele trabalha direto na pasta. */
  async changes(sessionId: string): Promise<AgentDiffResult | undefined> {
    const session = this.board.get(sessionId);
    if (!session?.worktree) return undefined;
    const client = await this.requireClient();
    if (!client) return undefined;
    return client.request<AgentDiffResult>('agents.diff', { sessionId });
  }

  async openDiff(sessionId: string, path: string): Promise<void> {
    const nome = this.board.get(sessionId)?.nome ?? l10n.t('agent');
    const uri = (side: 'base' | 'agente'): vscode.Uri =>
      vscode.Uri.from({ scheme: AGENT_SCHEME, path: `/${sessionId}/${side}/${path}` });
    await vscode.commands.executeCommand(
      'vscode.diff',
      uri('base'),
      uri('agente'),
      l10n.t('{0} (start ↔ {1})', path, nome),
      { preview: true },
    );
  }

  async applyFiles(sessionId: string, paths: readonly string[]): Promise<AgentApplyResult> {
    const client = await this.requireClient();
    if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
    const result = await client.request<AgentApplyResult>('agents.applyFiles', {
      sessionId,
      paths,
    });
    if (result.conflicts.length > 0) {
      void vscode.window.showWarningMessage(
        l10n.t(
          'Conflict applying {0}: the file now has markers for you to resolve.',
          result.conflicts.join(', '),
        ),
      );
    }
    this.filesChanged.fire(sessionId);
    return result;
  }

  async rejectFiles(sessionId: string, paths: readonly string[]): Promise<void> {
    const client = await this.requireClient();
    if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
    await client.request('agents.rejectFiles', { sessionId, paths });
    this.filesChanged.fire(sessionId);
  }

  private async agentFile(uri: vscode.Uri): Promise<string> {
    const [, sessionId, side, ...rest] = uri.path.split('/');
    const client = await this.getClient();
    if (!client || !sessionId) return '';
    const result = await client.request<AgentFileContentResult>('agents.fileContent', {
      sessionId,
      side,
      path: rest.join('/'),
    });
    return result.base64 ? Buffer.from(result.base64, 'base64').toString('utf8') : '';
  }

  /** Avisa o chat que os arquivos podem ter mudado, no máximo uma vez por segundo. */
  private filesMayHaveChanged(sessionId: string): void {
    if (this.fileTimers.has(sessionId)) return;
    this.fileTimers.set(
      sessionId,
      setTimeout(() => {
        this.fileTimers.delete(sessionId);
        this.filesChanged.fire(sessionId);
      }, 1000),
    );
  }

  async control(method: 'pause' | 'resume' | 'stop', sessionId: string): Promise<void> {
    const client = await this.requireClient();
    if (!client) throw new Error(l10n.t('FaKL Core is not responding.'));
    await client.request(`agents.${method}`, { sessionId });
  }

  private transcriptFor(sessionId: string): Transcript {
    let transcript = this.transcripts.get(sessionId);
    if (!transcript) {
      transcript = new Transcript();
      this.transcripts.set(sessionId, transcript);
    }
    return transcript;
  }

  private notify(sessionId: string, indexes: readonly number[]): void {
    const items = this.transcriptFor(sessionId).items;
    for (const index of indexes) {
      const item = items[index];
      if (item) this.patched.fire({ sessionId, index, item });
    }
  }

  private onEvent(event: FaklEvent): void {
    if (event.topic === 'claude.account') {
      // A conta exibida no chat e na Mesa vem de `agents.list`; a troca pode
      // ter sido iniciada por esta IDE, pela CLI ou pelo celular.
      const currentReload = this.reloading;
      void (currentReload ? currentReload.then(() => this.reload()) : this.reload());
      return;
    }
    if (!event.topic.startsWith('agent.') && event.topic !== 'cost.update') return;
    // Durante uma recarga, os eventos esperam a lista chegar e são reaplicados
    // por cima dela, na ordem em que vieram.
    if (this.pending) {
      this.pending.push(event);
      return;
    }
    const result = this.board.apply(event);
    if (result === 'unknown') {
      // Sessão iniciada por outro cliente (CLI, controle remoto).
      this.pending = [event];
      void this.reload();
      return;
    }
    this.record(event);
    if (result === 'changed') this.render();
  }

  /** Leva o evento para o log, a conversa e, se for o caso, uma notificação. */
  private record(event: FaklEvent): void {
    this.logs.write(event);
    if (
      event.topic === 'agent.file' ||
      event.topic === 'agent.applied' ||
      (event.topic === 'agent.tool' && (event.data as AgentToolEventData).status === 'completed') ||
      (event.topic === 'agent.state' && !BUSY.has((event.data as AgentStateEventData).state))
    ) {
      this.filesMayHaveChanged(event.subject);
    }
    this.notify(event.subject, this.transcriptFor(event.subject).apply(event));
    if (event.topic === 'agent.permission' && !this.isShowingInChat(event.subject)) {
      this.askPermission(event);
    }
  }

  private reload(): Promise<void> {
    const client = this.client;
    if (!client) return Promise.resolve();
    this.pending ??= [];
    this.reloading ??= client
      .request<AgentSessionInfo[]>('agents.list')
      .then(async (list) => {
        this.board.load(list);
        await this.hydrate(client, list);
      })
      .catch(() => undefined)
      .finally(() => {
        const queued = this.pending ?? [];
        this.pending = undefined;
        this.reloading = undefined;
        for (const event of queued) {
          this.board.apply(event);
          this.record(event);
        }
        this.render();
      });
    return this.reloading;
  }

  /**
   * Sessões que o Core guardou em disco (de antes de reiniciar a IDE ou o Core)
   * voltam com a conversa inteira: o chat e a Mesa mostram o que já foi dito.
   */
  private async hydrate(client: CoreClient, list: readonly AgentSessionInfo[]): Promise<void> {
    const missing = list.filter(
      (s) =>
        !this.transcripts.has(s.sessionId) && (s.retomavel === true || isFinalAgentState(s.state)),
    );
    await Promise.all(
      missing.map(async (session) => {
        try {
          const { items } = await client.request<AgentTranscriptResult>('agents.transcript', {
            sessionId: session.sessionId,
          });
          if (this.transcripts.has(session.sessionId)) return;
          // O Core já entrega a conversa montada, a mesma que o celular vê.
          this.transcripts.set(session.sessionId, Transcript.from(items));
          this.hydrated.fire(session.sessionId);
        } catch {
          // Sem a conversa guardada, a sessão aparece vazia; o resto continua valendo.
        }
      }),
    );
  }

  private render(): void {
    this.tree.refresh();
    this.updateTitle();
    this.sessionsChanged.fire();
  }

  private updateTitle(): void {
    const { active, cost } = this.board.totals();
    const costs = [...cost].map(([currency, amount]) =>
      currency === 'USD' ? l10n.t('${0}', amount.toFixed(2)) : `${currency} ${amount.toFixed(2)}`,
    );
    this.view.description =
      active === 0 && costs.length === 0
        ? ''
        : [active === 1 ? l10n.t('1 active') : l10n.t('{0} active', active), ...costs].join(' · ');
    this.view.badge =
      active > 0
        ? {
            value: active,
            tooltip: active === 1 ? l10n.t('1 active agent') : l10n.t('{0} active agents', active),
          }
        : undefined;
  }

  private askPermission(event: FaklEvent): void {
    const data = event.data as AgentPermissionEventData;
    const nome = this.board.get(event.subject)?.nome ?? l10n.t('The agent');
    const allow = l10n.t('Allow');
    const openChat = l10n.t('Open in chat');
    void vscode.window
      .showWarningMessage(
        l10n.t('{0} is asking for permission: {1}', nome, permissionLine(data.title, data.detail)),
        allow,
        l10n.t('Deny'),
        openChat,
      )
      .then(async (answer) => {
        if (answer === openChat) {
          await vscode.commands.executeCommand('fakl.chat.open', { sessionId: event.subject });
          return;
        }
        // Fechar a notificação sem responder nega, para o agente não ficar parado.
        await this.respondPermission(event.subject, data.id, answer === allow);
      })
      .then(undefined, (error: unknown) => {
        void vscode.window.showErrorMessage(l10n.t('Could not respond: {0}', String(error)));
      });
  }

  private async requireClient(): Promise<CoreClient | undefined> {
    const client = await this.getClient();
    if (!client) void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
    return client;
  }

  /** Sessão do item clicado na árvore, ou escolhida numa lista. */
  private async pickSession(
    arg: unknown,
    filter: (s: AgentSessionInfo) => boolean,
  ): Promise<AgentSessionInfo | undefined> {
    if (arg && typeof arg === 'object' && 'sessionId' in arg) {
      return this.board.get((arg as AgentSessionInfo).sessionId) ?? (arg as AgentSessionInfo);
    }
    const sessions = this.board.list().filter(filter);
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('No agents in that state.'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.nome, description: describe(s), session: s })),
      { title: l10n.t('Which agent?') },
    );
    return picked?.session;
  }

  private act(
    method: 'pause' | 'resume' | 'stop',
    filter: (s: AgentSessionInfo) => boolean,
  ): (arg?: unknown) => Promise<void> {
    return async (arg) => {
      const session = await this.pickSession(arg, filter);
      if (!session) return;
      try {
        await this.control(method, session.sessionId);
      } catch (error) {
        void vscode.window.showErrorMessage(`${session.nome}: ${String(error)}`);
      }
    };
  }

  /** Escolhe um agente instalado e o põe para trabalhar, com aviso enquanto sobe. */
  private async pickAndStart(): Promise<void> {
    const profiles = await this.detect();
    const ready = profiles.filter((p) => p.availability.status === 'pronto');
    if (ready.length === 0) {
      void vscode.window.showWarningMessage(
        l10n.t('No agents installed. See "FaKL: Available agents" to install one.'),
      );
      return;
    }
    const picked =
      ready.length === 1
        ? ready[0]
        : (
            await vscode.window.showQuickPick(
              ready.map((p) => ({ label: p.nome, description: p.id, profile: p })),
              { title: l10n.t('New agent'), placeHolder: l10n.t('Which agent?') },
            )
          )?.profile;
    if (!picked) return;
    try {
      const sessionId = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: l10n.t('Opening {0}…', picked.nome),
        },
        () => this.start(picked.id, true),
      );
      await vscode.commands.executeCommand('fakl.chat.open', { sessionId });
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t(
          '{0} did not open: {1}',
          picked.nome,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private registerCommands(): void {
    const notFinal = (s: AgentSessionInfo): boolean => actionGroup(s.state) !== 'encerrado';
    this.disposables.push(
      vscode.commands.registerCommand('fakl.agents.status', async () => {
        const profiles = await this.detect();
        const picked = await vscode.window.showQuickPick(
          profiles.map((p) => ({
            label: `${p.availability.status === 'pronto' ? '$(check)' : '$(warning)'} ${p.nome}`,
            description: availabilityLabel(p.availability.status),
            detail: p.availability.path ?? p.availability.install ?? '',
            profile: p,
          })),
          { title: l10n.t('Agents') },
        );
        const install = picked?.profile.availability.install;
        if (picked && install) await this.install(picked.profile.nome, install);
      }),
      vscode.commands.registerCommand('fakl.agents.chat', () =>
        vscode.commands.executeCommand('fakl.chat.open'),
      ),
      vscode.commands.registerCommand('fakl.agents.new', () => this.pickAndStart()),
      vscode.commands.registerCommand('fakl.agents.send', async (arg?: unknown) => {
        // Encerrada mas guardada também serve: a mensagem nova a retoma.
        const session = await this.pickSession(arg, (s) => notFinal(s) || s.retomavel === true);
        if (session) await vscode.commands.executeCommand('fakl.chat.open', session);
      }),
      vscode.commands.registerCommand(
        'fakl.agents.pause',
        this.act('pause', (s) => ['ativo', 'ocupado'].includes(actionGroup(s.state))),
      ),
      vscode.commands.registerCommand(
        'fakl.agents.resume',
        this.act('resume', (s) => s.state === 'pausado'),
      ),
      vscode.commands.registerCommand('fakl.agents.stop', this.act('stop', notFinal)),
      vscode.commands.registerCommand('fakl.agents.showLog', async (arg?: unknown) => {
        const session = await this.pickSession(arg, () => true);
        if (session) this.logs.channel(session.sessionId).show(true);
      }),
      vscode.commands.registerCommand('fakl.agents.terminal', async (arg?: unknown) => {
        const session = await this.pickSession(arg, (s) => !isFinalAgentState(s.state));
        if (!session) return;
        // Um terminal por sessão, na pasta onde o agente trabalha (RF-106).
        const name = l10n.t('Agent {0} ({1})', session.nome, session.sessionId.slice(-6));
        const existing = vscode.window.terminals.find((t) => t.name === name);
        const terminal =
          existing ??
          vscode.window.createTerminal({
            name,
            cwd: session.worktree?.path ?? session.cwd,
            iconPath: new vscode.ThemeIcon('hubot'),
          });
        terminal.show();
      }),
      // Terminal de leitura: o que o agente faz, ao vivo, sem teclado (ADR 0046).
      vscode.commands.registerCommand('fakl.agents.liveTerminal', async (arg?: unknown) => {
        const session = await this.pickSession(arg, () => true);
        if (!session) return;
        // Garante a conexão antes de abrir: o terminal anexa assim que aparece.
        if (!(await this.requireClient())) return;
        this.liveTerminals.show(session);
      }),
      // Assumir o agente: o terminal real dele, para digitar direto na CLI (ADR 0047).
      vscode.commands.registerCommand('fakl.agents.takeOver', async (arg?: unknown) => {
        const session = await this.pickSession(arg, (s) => !isFinalAgentState(s.state));
        if (!session) return;
        if (this.terminalHost.show(session.sessionId)) return;
        if (session.adaptador === 'terminal') {
          void vscode.window.showInformationMessage(
            l10n.t(
              'The terminal of this agent is not open in this window. Send a message in the chat to start it again.',
            ),
          );
          return;
        }
        // Agente ACP: não há terminal vivo; oferece continuar a conversa na CLI do provedor.
        await vscode.commands.executeCommand('fakl.agents.continueInTerminal', session);
      }),
      vscode.commands.registerCommand('fakl.agents.continueInTerminal', async (arg?: unknown) => {
        const session = await this.pickSession(arg, () => true);
        if (!session) return;
        await this.continueInTerminal(session);
      }),
      vscode.commands.registerCommand('fakl.agents.clearFinished', () => {
        const before = new Set(this.board.list().map((s) => s.sessionId));
        this.board.clearFinished();
        const after = new Set(this.board.list().map((s) => s.sessionId));
        const client = this.client;
        for (const id of before) {
          if (!after.has(id)) {
            this.logs.forget(id);
            this.transcripts.delete(id);
            // Some também do disco do Core; senão voltaria na próxima abertura da IDE.
            void client?.request('agents.forget', { sessionId: id }).catch(() => undefined);
          }
        }
        this.render();
      }),
      vscode.commands.registerCommand('fakl.agents.refresh', () => this.reload()),
    );
  }

  /** Abre um terminal com o comando que instala o agente. */
  async install(nome: string, command: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      l10n.t('{0} is not installed. Install with: {1}', nome, command),
      l10n.t('Install in terminal'),
    );
    if (choice) {
      const terminal = vscode.window.createTerminal(l10n.t('Install {0}', nome));
      terminal.show();
      terminal.sendText(command);
    }
  }
}
