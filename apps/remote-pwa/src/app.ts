import type {
  AgentPermissionRequest,
  AgentProfileEntry,
  AgentSessionInfo,
  AgentTranscriptResult,
  AgentUsageInfo,
  ClaudeAccountSlot,
  ClaudeAccountsState,
  CostSummary,
  Decision,
  EventNotificationParams,
  FaklEvent,
  Run,
  Task,
} from '@fakl/protocol';
import { l10n } from '@fakl/i18n';
import { RemoteError, RemoteSession } from '@fakl/remote';

import { toast } from './dom.js';
import { Conversations, LiveLines, type ConversationPatch } from './model.js';
import { forgetMachine, type SavedMachine } from './storage.js';

/** As abas da barra de baixo. */
export type Tab = 'agentes' | 'tarefas' | 'caixa' | 'cafe' | 'uso';

export type Route =
  | { readonly name: Tab }
  | { readonly name: 'ajustes' }
  | { readonly name: 'conversa'; readonly sessionId: string }
  | { readonly name: 'nova-conversa' }
  | { readonly name: 'mudancas'; readonly sessionId: string; readonly path?: string }
  | { readonly name: 'tarefa'; readonly taskId: string }
  | { readonly name: 'nova-tarefa' };

export type Conexao = 'conectando' | 'online' | 'offline';

/** Tópicos assinados: agentes, execuções, gasto, troca de conta do Claude e o CI do café (só leitura). */
const TOPICS = ['agent.*', 'run.*', 'cost.update', 'claude.*', 'ci.*'];

/** Tarefas que ganham os detalhes da execução ao atualizar. */
const TASK_DETAILS = 12;

/**
 * Estado e conexão do app. As telas leem daqui e pedem para ser avisadas;
 * nenhuma redesenha o app inteiro.
 */
class App {
  machine: SavedMachine | undefined;
  session: RemoteSession | undefined;
  conexao: Conexao = 'conectando';
  erro = '';

  tasks: Task[] = [];
  readonly runs = new Map<string, Run>();
  agents: AgentSessionInfo[] = [];
  decisions: Decision[] = [];
  permissions: AgentPermissionRequest[] = [];
  profiles: AgentProfileEntry[] = [];
  usage: CostSummary | undefined;
  /** Contas do Claude da IDE; `undefined` enquanto não chegam ou sem permissão. */
  claude: ClaudeAccountsState | undefined;
  /** O primeiro retrato chegou; antes dele, as listas mostram "carregando". */
  loaded = false;

  readonly conversations = new Conversations();
  readonly live = new LiveLines();

  /** Pilha de telas; a primeira é sempre uma aba. */
  stack: Route[] = [{ name: 'agentes' }];

  private retry = 1_000;
  /** Voltas no histórico feitas pelo próprio app, que o `popstate` deve ignorar. */
  private skipPops = 0;
  private readonly listeners = new Set<() => void>();
  private readonly patchListeners = new Set<(patch: ConversationPatch) => void>();
  private readonly eventListeners = new Set<(event: FaklEvent) => void>();
  private readonly routeListeners = new Set<() => void>();
  private timers = new Map<string, number>();

  get route(): Route {
    return this.stack.at(-1) ?? { name: 'agentes' };
  }

  get tab(): Tab {
    const first = this.stack[0];
    return first && isTab(first) ? first.name : 'agentes';
  }

  can(scope: 'decidir' | 'comandar'): boolean {
    return this.machine?.escopos.includes(scope) ?? false;
  }

  /** Pedidos de permissão e decisões esperando você. */
  get pending(): number {
    return this.permissions.length + this.decisions.length;
  }

  agent(sessionId: string): AgentSessionInfo | undefined {
    return this.agents.find((a) => a.sessionId === sessionId);
  }

  // -------------------------------------------------------------- avisos

  /** Os dados mudaram; a tela atual se atualiza. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPatch(listener: (patch: ConversationPatch) => void): () => void {
    this.patchListeners.add(listener);
    return () => this.patchListeners.delete(listener);
  }

  onEvent(listener: (event: FaklEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onRoute(listener: () => void): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }

  // -------------------------------------------------------------- navegação

  /** Abre uma tela por cima; o voltar do aparelho a fecha. */
  go(route: Route): void {
    if (isTab(route)) {
      // Tira do histórico as telas que estavam por cima, para o voltar do
      // aparelho não ter toques mortos depois.
      const depth = this.stack.length - 1;
      this.stack = [route];
      if (depth > 0) {
        this.skipPops++;
        history.go(-depth);
      }
    } else {
      this.stack.push(route);
      history.pushState({ depth: this.stack.length - 1 }, '');
    }
    this.routed();
  }

  /** Troca a tela de cima sem empilhar (como do diff da lista para o do arquivo). */
  replace(route: Route): void {
    this.stack[this.stack.length - 1] = route;
    this.routed();
  }

  back(): void {
    if (this.stack.length > 1) history.back();
  }

  /** O voltar do aparelho (ou do navegador) chegou. */
  popped(): void {
    if (this.skipPops > 0) {
      this.skipPops--;
      return;
    }
    if (this.stack.length > 1) {
      this.stack.pop();
      this.routed();
    }
  }

  private routed(): void {
    for (const listener of this.routeListeners) listener();
  }

  // -------------------------------------------------------------- pedidos

  /** Chama o Core; erro vira aviso e `undefined`. */
  async call<T>(method: string, params?: unknown): Promise<T | undefined> {
    const session = this.session;
    if (!session) {
      toast(l10n.t('No connection to the IDE.'), 'erro');
      return undefined;
    }
    try {
      return await session.request<T>(method, params);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'erro');
      return undefined;
    }
  }

  /**
   * Agrupa rajadas num pedido só, `delay` depois do primeiro aviso. O prazo
   * não recomeça a cada aviso: com o agente escrevendo sem parar, a lista
   * ainda se atualiza.
   */
  private soon(key: string, delay: number, run: () => Promise<void>): void {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      window.setTimeout(() => {
        this.timers.delete(key);
        void run().then(() => {
          this.changed();
        });
      }, delay),
    );
  }

  async refreshAll(): Promise<void> {
    // As contas do Claude vêm do `claude auth status` (lento): chegam depois, sem segurar a tela.
    void this.refreshClaude().then(() => {
      this.changed();
    });
    await Promise.all([
      this.refreshAgents(),
      this.refreshTasks(),
      this.refreshUsage(),
      this.profiles.length === 0 ? this.refreshProfiles() : Promise.resolve(),
    ]);
    this.loaded = true;
    this.changed();
  }

  async refreshAgents(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const [agents, permissions] = await Promise.all([
      session.request<AgentSessionInfo[]>('agents.list').catch(() => undefined),
      session.request<AgentPermissionRequest[]>('agents.permissions').catch(() => undefined),
    ]);
    if (agents) this.agents = agents;
    if (permissions) this.permissions = permissions;
  }

  async refreshTasks(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const [tasks, decisions] = await Promise.all([
      session.request<Task[]>('tasks.list').catch(() => undefined),
      session.request<Decision[]>('runs.decisions').catch(() => undefined),
    ]);
    if (decisions) this.decisions = decisions;
    if (!tasks) return;
    this.tasks = [...tasks].sort((a, b) => b.criadaEm.localeCompare(a.criadaEm));
    // Um pedido por vez: o canal é um só e não precisa de rajada.
    for (const task of this.tasks.slice(0, TASK_DETAILS)) {
      const detail = await session
        .request<{ runs: Run[] }>('tasks.get', { taskId: task.id })
        .catch(() => undefined);
      for (const run of detail?.runs ?? []) this.runs.set(run.id, run);
    }
  }

  async refreshUsage(): Promise<void> {
    const summary = await this.session
      ?.request<CostSummary>('costs.summary')
      .catch(() => undefined);
    if (summary) this.usage = summary;
  }

  async refreshClaude(): Promise<void> {
    const state = await this.session
      ?.request<ClaudeAccountsState>('claude.accounts.list')
      .catch(() => undefined);
    if (state) this.claude = state;
  }

  /**
   * Troca a conta ativa do Claude, a mesma ação da IDE: vale para os agentes
   * novos e, na IDE que já troca nos abertos (ADR 0027), também para eles.
   * `null` volta à conta padrão do Claude Code.
   */
  async setClaudeAccount(slot: ClaudeAccountSlot | null): Promise<boolean> {
    const state = await this.call<ClaudeAccountsState>('claude.accounts.setActive', {
      slot,
      aplicarEmAbertos: true,
    });
    if (!state) return false;
    this.claude = state;
    await this.refreshAgents();
    this.changed();
    return true;
  }

  async refreshProfiles(): Promise<void> {
    const profiles = await this.session
      ?.request<AgentProfileEntry[]>('profiles.list')
      .catch(() => undefined);
    if (profiles) this.profiles = profiles;
  }

  /** Abre a conversa: pede o retrato ao Core uma vez e segue pelos eventos. */
  async openConversation(sessionId: string): Promise<void> {
    if (this.conversations.has(sessionId)) return;
    this.conversations.begin(sessionId);
    let reason = l10n.t('No connection to the IDE.');
    const result = await this.session
      ?.request<AgentTranscriptResult>('agents.transcript', { sessionId })
      .catch((error: unknown) => {
        reason = error instanceof Error ? error.message : String(error);
        return undefined;
      });
    if (!result) {
      // Sem tentar de novo a cada atualização: a tela oferece o botão.
      this.conversations.fail(sessionId, reason);
      this.patched({ sessionId, indexes: [], reset: true });
      return;
    }
    this.patched(this.conversations.load(sessionId, result));
  }

  retryConversation(sessionId: string): void {
    this.conversations.retry(sessionId);
    void this.openConversation(sessionId);
  }

  private patched(patch: ConversationPatch): void {
    for (const listener of this.patchListeners) listener(patch);
  }

  // -------------------------------------------------------------- eventos

  private receive(event: FaklEvent): void {
    for (const listener of this.eventListeners) listener(event);
    const patch = this.conversations.apply(event);
    if (patch) this.patched(patch);
    if (this.live.apply(event)) this.soon('lista', 800, () => Promise.resolve());

    switch (event.topic) {
      case 'agent.output':
      case 'agent.tool':
      case 'agent.thumbnail':
      case 'agent.file':
      case 'agent.prompt':
        // Sessão que o celular ainda não conhece: alguém a abriu em outro lugar.
        if (!this.agent(event.subject) && event.topic !== 'agent.thumbnail') {
          this.soon('agentes', 300, () => this.refreshAgents());
        }
        return;
      case 'cost.update': {
        // O uso da sessão chega no evento; o resumo do dia vem com calma.
        const agent = this.agent(event.subject);
        if (agent) {
          this.agents = this.agents.map((a) =>
            a.sessionId === event.subject ? { ...a, usage: event.data as AgentUsageInfo } : a,
          );
          this.soon('lista', 800, () => Promise.resolve());
        }
        this.soon('uso', 2_000, () => this.refreshUsage());
        return;
      }
      default:
        if (event.topic.startsWith('claude.')) {
          // Trocaram a conta (aqui, na IDE ou no terminal): contas e agentes mudam.
          this.soon('claude', 300, () => this.refreshClaude());
          this.soon('agentes', 300, () => this.refreshAgents());
        } else if (event.topic.startsWith('run.')) {
          this.soon('tarefas', 500, () => this.refreshTasks());
          if (event.topic === 'run.limit') this.soon('uso', 300, () => this.refreshUsage());
        } else {
          this.soon('agentes', 250, () => this.refreshAgents());
        }
    }
  }

  // -------------------------------------------------------------- conexão

  /** Chamado quando o aparelho deixa de estar pareado. */
  onForgotten: (message: string) => void = () => undefined;

  async connect(): Promise<void> {
    const machine = this.machine;
    if (!machine) return;
    this.conexao = 'conectando';
    this.changed();
    try {
      const session = await RemoteSession.connect(machine.target, machine.keys);
      this.session = session;
      this.conexao = 'online';
      this.erro = '';
      this.retry = 1_000;
      session.onNotification((method, params) => {
        if (method === 'events.event') this.receive((params as EventNotificationParams).event);
      });
      session.onClose((error) => {
        if (this.session !== session) return;
        this.session = undefined;
        void this.lost(error);
      });
      // O que estava aberto pode ter perdido eventos enquanto a conexão caiu.
      this.conversations.clear();
      await session.request('events.subscribe', { topics: TOPICS });
      await this.refreshAll();
      const route = this.route;
      if (route.name === 'conversa') await this.openConversation(route.sessionId);
    } catch (error) {
      await this.lost(error);
    }
  }

  private async lost(error: unknown): Promise<void> {
    const motivo = error instanceof RemoteError ? error.motivo : 'offline';
    if (motivo === 'desconhecido' || motivo === 'revogado') {
      await forgetMachine();
      this.machine = undefined;
      this.onForgotten(
        l10n.t('This device is no longer paired. Generate a QR code in the IDE to pair again.'),
      );
      return;
    }
    this.conexao = 'offline';
    this.erro = error instanceof Error ? error.message : String(error);
    this.changed();
    window.setTimeout(() => {
      if (!this.session && document.visibilityState === 'visible') void this.connect();
    }, this.retry);
    this.retry = Math.min(this.retry * 2, 30_000);
  }

  /** A tela voltou: reconecta na hora, sem esperar o intervalo. */
  wake(): void {
    if (this.machine && !this.session && this.conexao !== 'conectando') {
      this.retry = 1_000;
      void this.connect();
    }
  }

  disconnect(): void {
    this.session?.close();
    this.session = undefined;
  }
}

export function isTab(route: Route): route is { readonly name: Tab } {
  return ['agentes', 'tarefas', 'caixa', 'cafe', 'uso'].includes(route.name);
}

export const app = new App();
