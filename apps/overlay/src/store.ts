import { l10n } from '@fakl/i18n';
import type {
  AgentPermissionRequest,
  AgentProfileEntry,
  AgentSessionInfo,
  AgentStartParams,
  AgentStartResult,
  AgentTranscriptResult,
  AgentUsageInfo,
  ClaudeAccountSlot,
  ClaudeAccountsState,
  CostSummary,
  Decision,
  FaklEvent,
  ProviderWindows,
  Run,
  Task,
  UsageWindowsResult,
} from '@fakl/protocol';

import type { OverlayBridge, OverlayMode } from './bridge.js';
import {
  balloon,
  blockedByCap,
  Conversations,
  Drafts,
  LimitTracker,
  LiveLines,
  newFailures,
  type ConversationPatch,
  type Snapshot,
} from './model.js';
import { CoreClient, type Connection } from './rpc.js';

/** As telas do painel. */
export type View =
  | { readonly name: 'inicio' }
  | { readonly name: 'conversa'; readonly sessionId: string }
  | { readonly name: 'nova' };

/** Tarefas que ganham os detalhes da execução ao atualizar. */
const TASK_DETAILS = 6;

/** Quanto o balão fica no pet. */
export const BALLOON_MS = 5_000;

const PREFS_KEY = 'fakl-overlay';

interface Prefs {
  naoPerturbe: boolean;
  fixado: boolean;
}

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    // "Não perturbe" vem do processo principal (onQuiet), dono do valor junto com a bandeja.
    return { naoPerturbe: false, fixado: saved.fixado === true };
  } catch {
    return { naoPerturbe: false, fixado: false };
  }
}

/**
 * Estado e conexão do overlay. O pet e o painel leem daqui e pedem para ser
 * avisados; nenhum dos dois fala com a ponte direto.
 */
export class Overlay {
  readonly core: CoreClient;
  mode: OverlayMode = 'pet';
  view: View = { name: 'inicio' };
  erro = '';

  agents: AgentSessionInfo[] = [];
  permissions: AgentPermissionRequest[] = [];
  decisions: Decision[] = [];
  tasks: Task[] = [];
  readonly runs = new Map<string, Run>();
  profiles: AgentProfileEntry[] = [];
  usage: CostSummary | undefined;
  /** Sessão de 5 h e semana dos planos, como o Core lê dos registros dos CLIs. */
  windows: ProviderWindows[] = [];
  claude: ClaudeAccountsState | undefined;
  loaded = false;

  readonly conversations = new Conversations();
  readonly live = new LiveLines();
  readonly limits = new LimitTracker();
  readonly drafts = new Drafts();
  /** Falharam desde a última vez que o painel abriu. */
  readonly failed = new Set<string>();
  prefs: Prefs = loadPrefs();
  /** O balão atual do pet e quando ele some. */
  bubble: { text: string; until: number } | undefined;

  private last: Snapshot | undefined;
  /** Uma conversa nova por vez: botão, formulário e atalho passam pela mesma trava. */
  private starting = false;
  /** A sessão já criada de uma conversa nova cujo envio falhou, para tentar de novo nela. */
  private unsent: { key: string; sessionId: string } | undefined;
  /** Conversas com um envio em curso. */
  private readonly sending = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly patchListeners = new Set<(patch: ConversationPatch) => void>();
  private readonly noticeListeners = new Set<(text: string, tone: 'info' | 'erro') => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(readonly bridge: OverlayBridge) {
    this.core = new CoreClient(bridge);
    this.core.onEvent((event) => {
      this.receive(event);
    });
    this.core.onStatus((status) => {
      void this.statusChanged(status);
    });
    bridge.onCommand((command) => {
      if (command === 'pet') this.collapse();
      else this.open(command === 'compor' ? { name: 'nova' } : { name: 'inicio' });
    });
    bridge.onQuiet((quiet) => {
      this.prefs = { ...this.prefs, naoPerturbe: quiet };
      if (quiet) this.bubble = undefined;
      this.emit();
    });
  }

  get connection(): Connection {
    return this.core.status;
  }

  agent(sessionId: string): AgentSessionInfo | undefined {
    return this.agents.find((a) => a.sessionId === sessionId);
  }

  /** O retrato do que trava ou move os agentes, para o pet e o balão. */
  snapshot(): Snapshot {
    const blocked = this.usage?.bloqueados ?? [];
    const limited = this.limits.ids() as Set<string>;
    for (const agent of this.agents) {
      if (blockedByCap(agent, blocked, this.profiles)) limited.add(agent.sessionId);
    }
    return {
      agents: this.agents,
      permissions: this.permissions,
      decisions: this.decisions.filter((d) => d.escolha === undefined),
      limited,
      failed: new Set(this.failed),
    };
  }

  limitReason(sessionId: string): string | undefined {
    if (this.limits.reason(sessionId)) return this.limits.reason(sessionId);
    const agent = this.agent(sessionId);
    if (agent && blockedByCap(agent, this.usage?.bloqueados ?? [], this.profiles)) {
      return l10n.t('Provider daily cap reached');
    }
    return undefined;
  }

  // -------------------------------------------------------------- avisos

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPatch(listener: (patch: ConversationPatch) => void): () => void {
    this.patchListeners.add(listener);
    return () => this.patchListeners.delete(listener);
  }

  onNotice(listener: (text: string, tone: 'info' | 'erro') => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  notice(text: string, tone: 'info' | 'erro' = 'info'): void {
    for (const listener of this.noticeListeners) listener(text, tone);
  }

  /** Os dados mudaram: confere o balão e avisa as telas. */
  changed(): void {
    const next = this.snapshot();
    if (this.last && this.loaded) {
      for (const id of newFailures(this.last, next)) this.failed.add(id);
      const text = balloon(this.last, next);
      if (text && !this.prefs.naoPerturbe && this.mode === 'pet') {
        this.bubble = { text, until: Date.now() + BALLOON_MS };
        this.later('balao', BALLOON_MS + 50, () => {
          this.bubble = undefined;
          this.emit();
        });
      }
    }
    if (this.loaded) this.last = this.snapshot();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // -------------------------------------------------------------- formas e telas

  /** Abre o painel numa tela. */
  open(view: View = this.view): void {
    this.view = view;
    // Abrir o painel é olhar: o vermelho das falhas já foi visto.
    this.failed.clear();
    this.bubble = undefined;
    if (view.name === 'conversa') void this.openConversation(view.sessionId);
    // As janelas dos planos andam devagar; olhar o painel é um bom momento para reler.
    this.soon('janelas', 50, () => this.refreshWindows());
    if (this.mode !== 'painel') {
      this.mode = 'painel';
      this.bridge.setMode('painel');
    }
    this.changed();
  }

  /** Recolhe para o pet; a tela fica guardada para quando o painel abrir de novo. */
  collapse(): void {
    if (this.mode === 'pet') return;
    this.mode = 'pet';
    this.bridge.setMode('pet');
    this.emit();
  }

  setPref(name: keyof Prefs, value: boolean): void {
    this.prefs = { ...this.prefs, [name]: value };
    if (name === 'naoPerturbe') this.bridge.setQuiet(value);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // Sem armazenamento, a preferência vale só até fechar.
    }
    if (name === 'naoPerturbe' && value) this.bubble = undefined;
    this.emit();
  }

  // -------------------------------------------------------------- pedidos

  /** Chama o Core; erro vira aviso e `undefined`. */
  async call<T>(method: string, params?: unknown): Promise<T | undefined> {
    try {
      return await this.core.call<T>(method, params);
    } catch (error) {
      this.notice(error instanceof Error ? error.message : String(error), 'erro');
      return undefined;
    }
  }

  /** Traz a IDE para a frente; com `sessionId`, abre a conversa dele. */
  reveal(sessionId?: string): void {
    void this.call('ui.reveal', sessionId ? { sessionId } : {});
  }

  /** Responde um pedido; `always` permite também os próximos iguais da sessão. */
  async answerPermission(
    request: AgentPermissionRequest,
    allow: boolean,
    always = false,
  ): Promise<void> {
    const result = await this.call('agents.permission', {
      sessionId: request.sessionId,
      id: request.id,
      allow,
      ...(allow && always ? { sempre: true } : {}),
    });
    if (result === undefined) return;
    this.permissions = this.permissions.filter(
      (p) => !(p.sessionId === request.sessionId && p.id === request.id),
    );
    this.changed();
  }

  async decide(decision: Decision, escolha: string): Promise<void> {
    const result = await this.call('runs.decide', {
      runId: decision.runId,
      decisionId: decision.id,
      escolha,
      origem: 'ide',
    });
    if (result === undefined) return;
    this.decisions = this.decisions.filter((d) => d.id !== decision.id);
    this.changed();
  }

  /** Retoma um agente parado: pausado volta; parado por erro recebe um "continue". */
  async resume(agent: AgentSessionInfo): Promise<void> {
    const result =
      agent.state === 'pausado'
        ? await this.call('agents.resume', { sessionId: agent.sessionId })
        : await this.call('agents.send', {
            sessionId: agent.sessionId,
            message: l10n.t('Continue where you left off.'),
          });
    if (result === undefined) return;
    this.soon('agentes', 200, () => this.refreshAgents());
  }

  /**
   * Troca a conta ativa do Claude, a mesma ação da IDE: vale para os novos e
   * para os agentes abertos (ADR 0027). `null` volta à conta padrão.
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

  async send(sessionId: string, message: string): Promise<boolean> {
    const result = await this.call('agents.send', { sessionId, message });
    return result !== undefined;
  }

  /** Há um envio em curso nesta conversa. */
  isSending(sessionId: string): boolean {
    return this.sending.has(sessionId);
  }

  /**
   * Envia pelo compositor, uma mensagem por vez por conversa: Enter repetido ou
   * clique junto com o atalho não duplicam. `false` se falhou ou já havia um envio.
   */
  async compose(sessionId: string, message: string): Promise<boolean> {
    if (this.sending.has(sessionId)) return false;
    this.sending.add(sessionId);
    try {
      return await this.send(sessionId, message);
    } finally {
      this.sending.delete(sessionId);
      this.emit();
    }
  }

  get isStarting(): boolean {
    return this.starting;
  }

  /**
   * Começa uma conversa: abre a sessão e manda o pedido. Se o envio falhar, a
   * sessão fica guardada e a próxima tentativa com os mesmos parâmetros manda o
   * pedido nela, sem abrir outra. Devolve o id da sessão ou `undefined` se
   * falhou (o erro já foi avisado) ou se já havia uma em andamento.
   */
  async startConversation(params: AgentStartParams, message: string): Promise<string | undefined> {
    if (this.starting) return undefined;
    this.starting = true;
    this.emit();
    try {
      const key = JSON.stringify(params);
      let sessionId = this.unsent?.key === key ? this.unsent.sessionId : undefined;
      if (!sessionId) {
        this.unsent = undefined;
        const started = await this.call<AgentStartResult>('agents.start', params);
        if (!started) return undefined;
        sessionId = started.sessionId;
        this.unsent = { key, sessionId };
      }
      if (!(await this.send(sessionId, message))) return undefined;
      this.unsent = undefined;
      return sessionId;
    } finally {
      this.starting = false;
      this.emit();
    }
  }

  /**
   * Agrupa rajadas num pedido só, `delay` depois do primeiro aviso; o prazo
   * não recomeça a cada aviso.
   */
  private soon(key: string, delay: number, run: () => Promise<void>): void {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void run().then(() => {
          this.changed();
        });
      }, delay),
    );
  }

  private later(key: string, delay: number, run: () => void): void {
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        run();
      }, delay),
    );
  }

  async refreshAll(): Promise<void> {
    void this.refreshClaude().then(() => {
      this.changed();
    });
    await Promise.all([
      this.refreshAgents(),
      this.refreshTasks(),
      this.refreshUsage(),
      this.refreshWindows(),
      this.profiles.length === 0 ? this.refreshProfiles() : Promise.resolve(),
    ]);
    this.loaded = true;
    this.changed();
  }

  async refreshAgents(): Promise<void> {
    const [agents, permissions] = await Promise.all([
      this.core.call<AgentSessionInfo[]>('agents.list').catch(() => undefined),
      this.core.call<AgentPermissionRequest[]>('agents.permissions').catch(() => undefined),
    ]);
    if (agents) {
      this.agents = agents;
      this.limits.prune(agents);
      // Limites de antes de o overlay abrir só o Core sabe.
      this.limits.sync(agents);
    }
    if (permissions) this.permissions = permissions;
  }

  async refreshTasks(): Promise<void> {
    const [tasks, decisions] = await Promise.all([
      this.core.call<Task[]>('tasks.list').catch(() => undefined),
      this.core.call<Decision[]>('runs.decisions').catch(() => undefined),
    ]);
    if (decisions) this.decisions = decisions;
    if (!tasks) return;
    this.tasks = [...tasks].sort((a, b) => b.criadaEm.localeCompare(a.criadaEm));
    for (const task of this.tasks.slice(0, TASK_DETAILS)) {
      const detail = await this.core
        .call<{ runs: Run[] }>('tasks.get', { taskId: task.id })
        .catch(() => undefined);
      for (const run of detail?.runs ?? []) this.runs.set(run.id, run);
    }
  }

  async refreshUsage(): Promise<void> {
    const summary = await this.core.call<CostSummary>('costs.summary').catch(() => undefined);
    if (summary) this.usage = summary;
  }

  async refreshWindows(): Promise<void> {
    const result = await this.core.call<UsageWindowsResult>('usage.windows').catch(() => undefined);
    if (result) this.windows = [...result.janelas];
  }

  async refreshClaude(): Promise<void> {
    const state = await this.core
      .call<ClaudeAccountsState>('claude.accounts.list')
      .catch(() => undefined);
    if (state) this.claude = state;
  }

  async refreshProfiles(): Promise<void> {
    const profiles = await this.core
      .call<AgentProfileEntry[]>('profiles.list')
      .catch(() => undefined);
    if (profiles) this.profiles = profiles;
  }

  /** Abre a conversa: pede o retrato ao Core uma vez e segue pelos eventos. */
  async openConversation(sessionId: string): Promise<void> {
    if (this.conversations.has(sessionId)) return;
    this.conversations.begin(sessionId);
    let reason = l10n.t('No connection to the Core.');
    const result = await this.core
      .call<AgentTranscriptResult>('agents.transcript', { sessionId, limit: 120 })
      .catch((error: unknown) => {
        reason = error instanceof Error ? error.message : String(error);
        return undefined;
      });
    if (!result) {
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
    const patch = this.conversations.apply(event);
    if (patch) this.patched(patch);
    if (this.live.apply(event)) this.soon('lista', 800, () => Promise.resolve());
    if (this.limits.apply(event)) this.soon('lista', 100, () => Promise.resolve());

    switch (event.topic) {
      case 'agent.output':
      case 'agent.tool':
      case 'agent.thumbnail':
      case 'agent.file':
      case 'agent.prompt':
        if (!this.agent(event.subject) && event.topic !== 'agent.thumbnail') {
          this.soon('agentes', 300, () => this.refreshAgents());
        }
        return;
      case 'cost.update': {
        if (this.agent(event.subject)) {
          this.agents = this.agents.map((a) =>
            a.sessionId === event.subject ? { ...a, usage: event.data as AgentUsageInfo } : a,
          );
          this.soon('lista', 800, () => Promise.resolve());
        }
        this.soon('uso', 2_000, () => this.refreshUsage());
        this.soon('janelas', 30_000, () => this.refreshWindows());
        return;
      }
      default:
        if (event.topic.startsWith('claude.')) {
          this.soon('claude', 300, () => this.refreshClaude());
          this.soon('agentes', 300, () => this.refreshAgents());
        } else if (event.topic.startsWith('run.')) {
          this.soon('tarefas', 400, () => this.refreshTasks());
          if (event.topic === 'run.limit') {
            this.soon('uso', 300, () => this.refreshUsage());
            this.soon('agentes', 300, () => this.refreshAgents());
          }
        } else {
          this.soon('agentes', 200, () => this.refreshAgents());
        }
    }
  }

  // -------------------------------------------------------------- conexão

  private async statusChanged(status: Connection): Promise<void> {
    if (status !== 'online') {
      this.emit();
      return;
    }
    // O que estava aberto pode ter perdido eventos enquanto a conexão caiu.
    this.conversations.clear();
    this.emit();
    await this.refreshAll();
    if (this.view.name === 'conversa') await this.openConversation(this.view.sessionId);
  }
}
