import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

import {
  adapterForProfile,
  applyFiles,
  changedFiles,
  createWorktree,
  isGitRepo,
  fileContent,
  rejectFiles,
  defaultProfiles,
  removeWorktree,
  reopenWorktree,
  type AgentAdapter,
  type AgentEvent,
  type AgentHandle,
  type AgentProfile,
  type McpServerRef,
  type PermissionPolicy,
  type StopReason,
  type Usage,
  type Worktree,
} from '@fakl/agents';
import { lastLine, Transcript, TRANSCRIPT_TOPICS } from '@fakl/conversa';
import { l10n } from '@fakl/i18n';
import {
  FaklErrorCode,
  isFinalAgentState,
  isLimitText,
  isMcpHttpServer,
  isClaudeAccountSlot,
  isPermissionMode,
  PERMISSION_MODES,
  type AgentLimitInfo,
  type AgentState,
  type ClaudeAccountRef,
  type ClaudeAccountSlot,
  type PermissionPolicyName,
} from '@fakl/protocol';
import type {
  McpSessionServer,
  AgentAnswerEventData,
  AgentApplyResult,
  AgentChangedFile,
  AgentDiffResult,
  AgentFileContentResult,
  AgentModeEventData,
  AgentOptionsEventData,
  AgentOutputEventData,
  AgentPermissionEventData,
  AgentPermissionRequest,
  AgentProfileAvailability,
  AgentPromptEventData,
  AgentRecoveryInfo,
  AgentRecoveryEventData,
  AgentSessionInfo,
  AgentStartResult,
  AgentTranscriptEntry,
  AgentTranscriptResult,
  ChatItem,
  SshRemoteRoot,
  AgentStateEventData,
  AgentToolEventData,
} from '@fakl/protocol';

import {
  type AgentSessionStore,
  historyContext,
  SESSION_FORMAT,
  type StoredSession,
} from './agent-store.js';
import type { EventBus } from './events/bus.js';
import {
  objectParams,
  RpcError,
  stringArrayParam,
  stringParam,
  type Router,
} from './rpc/router.js';
import { ulid } from './ulid.js';
import { MIN_RESUME_DELAY_MS, UNKNOWN_RESET_MS, parseSessionLimit } from './session-limit.js';

const WORKING: ReadonlySet<AgentState> = new Set<AgentState>([
  'pensando',
  'executando',
  'aguardando-permissão',
]);
/** Estados em que a vez terminou e dá para trocar a conta sem interromper nada. */
const IDLE: ReadonlySet<AgentState> = new Set<AgentState>(['ocioso', 'aguardando-você']);

/** A primeira linha não vazia do aviso de limite, curta para caber nas listas. */
function limitReason(text: string): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? text).trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Perfis do Claude Code que usam as contas da IDE (ADR 0021). */
function usesClaudeAccount(profile: AgentProfile): boolean {
  return profile.provedor === 'anthropic' && profile.adaptador === 'acp';
}

/** A conversa da memória no formato do diário, para sessões que não vão para o disco. */
function entriesOf(transcript: Transcript): AgentTranscriptEntry[] {
  return transcript.items.flatMap((item): AgentTranscriptEntry[] => {
    if (item.kind === 'user') return [{ t: 'user', text: item.text, ts: '' }];
    if (item.kind !== 'agent') return [];
    return [
      { t: 'event', topic: 'agent.output', data: { kind: 'message', text: item.text }, ts: '' },
    ];
  });
}

/** O registro com outra conta; sem conta, a retomada usa a ativa. */
function withAccount(record: StoredSession, slot: ClaudeAccountSlot | undefined): StoredSession {
  const rest = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'contaClaude'),
  ) as unknown as StoredSession;
  return slot ? { ...rest, contaClaude: slot } : rest;
}

/** Eventos que entram na conversa guardada, os mesmos que o chat mostra. */
const JOURNAL_TOPICS = [
  'agent.output',
  'agent.tool',
  'agent.permission',
  'agent.answer',
  'agent.applied',
  'agent.state',
];
/** Mudanças de estado que o chat mostra como aviso na conversa. */
const JOURNAL_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'pausado',
  'concluído',
  'falhou',
  'parado',
]);
const TITLE_CHARS = 80;
const SAVE_DELAY_MS = 300;

function titleOf(message: string): string {
  const line = message.trim().replace(/\s+/g, ' ');
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/** Itens guardados por conversa; os mais antigos saem. */
const TRANSCRIPT_MAX_ITEMS = 2_000;
/** Itens que `agents.transcript` devolve quando não pedem outro número. */
const TRANSCRIPT_DEFAULT_LIMIT = 300;
/**
 * Bytes máximos de uma resposta de `agents.transcript`. O relay derruba
 * mensagens acima de 1 MB, e a cifra e o base64 crescem o texto em cerca de 40%.
 */
const TRANSCRIPT_MAX_BYTES = 500_000;
/** Texto máximo de um item da conversa guardada; o começo de falas maiores sai. */
const ITEM_MAX_CHARS = 100_000;

/** Política do adaptador para o modo: o autopilot, para o agente, é aprovar tudo. */
export function adapterPolicy(mode: PermissionPolicyName): PermissionPolicy {
  return mode === 'autopilot' ? 'aprovar-tudo' : mode;
}

/** Modos em que nenhum pedido do agente espera resposta. */
function approvesAll(mode: PermissionPolicyName): boolean {
  return mode === 'aprovar-tudo' || mode === 'autopilot';
}

/** Regras do perfil antes do contexto de quem iniciou o agente. */
/**
 * Regra de todo agente: ficar na tarefa e longe do que é da máquina. O Gemini,
 * no primeiro teste real, listou o ambiente e a pasta ~/.fakl antes de começar.
 */
export function focusRule(): string {
  return l10n.t(
    'Work only on what was asked, inside the working folder. Do not list environment variables, do not read ~/.fakl, ~/.ssh, keys or credentials, and do not explore folders outside the project unless the task explicitly asks for it.',
  );
}

/**
 * Regra de quem trabalha num worktree: a cópia do usuário não é dele. Agentes
 * mesclavam o próprio PR e depois rodavam stash e pull na pasta do usuário, que
 * ficava suja e fora do `main`. Numa tarefa, quem entrega é a execução.
 */
export function worktreeRule(
  worktree: Pick<Worktree, 'path' | 'branch' | 'repoRoot'>,
  inTask = false,
): string {
  return [
    l10n.t('You work in your own worktree, {0}, on branch {1}.', worktree.path, worktree.branch),
    l10n.t(
      "The folder {0} is the user's working copy: do not edit, create or delete files in it and do not run git in it (checkout, switch, pull, merge, rebase, reset, stash, commit, clean).",
      worktree.repoRoot,
    ),
    l10n.t(
      "Do not use git stash: the stack is shared with the user's copy. To set work aside, commit on your branch.",
    ),
    inTask
      ? l10n.t(
          "This session belongs to a task: do not push or open a PR; the task's run makes the delivery.",
        )
      : l10n.t(
          "To deliver, commit on your branch, push it and open a PR. After the merge, do not update the user's copy; the user does the pull.",
        ),
  ].join(' ');
}

export function composePrompt(
  profile: AgentProfile,
  extra?: string,
  worktree?: { readonly tree: Worktree; readonly inTask: boolean },
): string {
  const parts: string[] = [focusRule()];
  if (worktree) parts.push(worktreeRule(worktree.tree, worktree.inTask));
  if (profile.regras?.length) {
    parts.push(
      `${l10n.t('Rules for this work:')}\n${profile.regras.map((rule) => `- ${rule}`).join('\n')}`,
    );
  }
  if (extra?.trim()) parts.push(extra.trim());
  return parts.join('\n\n');
}

/** Pedido ao agente que volta de um limite de sessão. */
function resumeAfterLimit(): string {
  return l10n.t(
    'Continue the task from where it stopped before the session limit, using the existing context and history. Do not ask the user to resend the request.',
  );
}

/** Raízes remotas válidas do pedido (host + caminho absoluto no servidor). */
export function parseRemoteRoots(value: unknown): SshRemoteRoot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw RpcError.invalidParams(l10n.t('remotas must be a list'));
  return value.map((item: unknown) => {
    const root = item as { host?: unknown; caminho?: unknown } | null;
    if (
      typeof root?.host !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(root.host) ||
      typeof root.caminho !== 'string' ||
      !root.caminho.startsWith('/') ||
      root.caminho.includes('\u0000') ||
      root.caminho.includes('\n')
    ) {
      throw RpcError.invalidParams(
        l10n.t('remotas: each item needs a host (alias) and an absolute path'),
      );
    }
    return { host: root.host, caminho: root.caminho };
  });
}

/** Contexto das pastas remotas do workspace, para o prompt do agente. */
export function remoteContext(roots: readonly SshRemoteRoot[]): string {
  if (roots.length === 0) return '';
  return [
    l10n.t(
      'The IDE workspace also has folders on SSH servers. They are NOT in your local working folder; use the MCP tools ssh_list, ssh_stat, ssh_read, ssh_write and ssh_exec (with cwd), passing the host and the path. Every use goes through the host policy (read-only, approval, audit). Remote folders:',
    ),
    ...roots.map((root) => `- host ${root.host}: ${root.caminho}`),
  ].join('\n');
}

export interface AgentRuntimeOptions {
  /**
   * Perfis disponíveis; uma função é lida a cada uso, para valer o que está nos
   * arquivos agora. Sem eles (testes), valem todos os perfis de fábrica.
   */
  readonly profiles?: readonly AgentProfile[] | (() => readonly AgentProfile[]);
  /** Servidores MCP da configuração, entregues a todo agente (RF-006). */
  readonly mcpServers?: () => readonly McpSessionServer[];
  /** Política quando quem inicia o agente não escolhe uma. */
  readonly defaultPermissions?: () => PermissionPolicyName;
  /** Motivo para recusar trabalho novo de um perfil (teto diário, RNF-13). */
  readonly guard?: (profile: AgentProfile) => string | undefined;
  /** Servidores MCP de cada sessão quando quem inicia não escolhe (o `fakl` com o vault). */
  readonly sessionMcp?: (sessionId: string, profile: AgentProfile) => readonly McpServerRef[];
  /** Instruções a mais das sessões iniciadas pela IDE (`agents.start`), como a orquestração no chat. */
  readonly sessionPrompt?: () => string | undefined;
  /** Pedidos de aprovação do próprio Core, respondidos pelo mesmo `agents.permission`. */
  readonly approvals?: { respond(sessionId: string, id: string, allow: boolean): boolean };
  /** Tira segredos do texto antes de ele virar evento (SDD 14.1). */
  readonly redact?: (text: string) => string;
  /**
   * Variáveis com segredo do agente de um perfil: a chave de API do provedor
   * dele (ADR 0035). Vão só ao processo do agente; nada disso é gravado.
   */
  readonly providerEnv?: (profile: AgentProfile) => Readonly<Record<string, string>>;
  /** Contas do Claude (ADR 0021): escolhe o slot de um agente novo e isola o ambiente dele. */
  readonly claudeAccounts?: {
    resolve(requested?: ClaudeAccountSlot): Promise<ClaudeAccountSlot | undefined>;
    env(slot: ClaudeAccountSlot): Record<string, string>;
    ref(slot: ClaudeAccountSlot): ClaudeAccountRef;
    /** Diz de que conta é o uso da sessão do Claude Code (id ACP) daqui em diante (ADR 0027). */
    recordSession?(sessionId: string, slot: ClaudeAccountSlot | undefined): Promise<void>;
    /** A sessão do Claude Code teve atividade: a atribuição dela não vence. */
    touchSession?(sessionId: string): void;
  };
  /**
   * Antes de iniciar o processo do agente, com o ambiente que ele vai
   * receber; o Core sincroniza aqui os agentes e skills da biblioteca.
   */
  readonly beforeStart?: (
    profile: AgentProfile,
    env: Readonly<Record<string, string>>,
  ) => Promise<void>;
  /** Troca o adaptador nos testes. */
  readonly adapterFor?: (profile: AgentProfile) => AgentAdapter;
  readonly log?: (message: string) => void;
  /** Pasta pessoal, onde ficam os worktrees; muda nos testes. */
  readonly home?: string;
  /**
   * Onde as sessões ficam guardadas (`~/.fakl/data/agents`). Sem isso, as
   * sessões somem ao reiniciar o Core, como antes.
   */
  readonly store?: AgentSessionStore;
}

export interface LaunchOptions {
  readonly profileId: string;
  /** Pasta do agente, ou do repositório quando ele ganha worktree. */
  readonly cwd: string;
  /** Worktree próprio; com `base`, parte desse branch ou commit. */
  readonly worktree?: boolean | { readonly base: string };
  readonly permissions?: PermissionPolicyName;
  readonly systemPrompt?: string;
  /** Tarefa da sessão: entra no nome do branch e na conta de custos. */
  readonly taskId?: string;
  /** Conta (slot) do Claude; sem ela, vale a conta ativa. Só perfis do Claude Code a usam. */
  readonly claudeAccount?: ClaudeAccountSlot;
  /** Servidores MCP só desta sessão, como o `fakl` do maestro, que leva o token dela. */
  readonly extraMcp?: (sessionId: string, profile: AgentProfile) => readonly McpServerRef[];
}

interface Session {
  readonly id: string;
  readonly profile: AgentProfile;
  readonly taskId?: string;
  readonly cwd: string;
  /** Trocado quando a sessão é retomada depois de encerrar. */
  handle: AgentHandle;
  /** Regras e contexto do início da conversa; guardados para recriar a sessão. */
  readonly systemPrompt?: string;
  readonly createdAt: string;
  /** Primeira mensagem do usuário, como título da conversa. */
  title?: string;
  /** Motivo do último encerramento. */
  stopReason?: string | undefined;
  saveTimer?: NodeJS.Timeout | undefined;
  readonly worktree?: Worktree;
  /** Conta do Claude; muda quando a sessão encerrada troca de conta. */
  account?: ClaudeAccountRef | undefined;
  /** Servidores MCP só desta sessão, pedidos de novo quando ela reabre com outra conta. */
  readonly extraMcp?: (sessionId: string, profile: AgentProfile) => readonly McpServerRef[];
  /** Trocada por outra (mesmo id) ao mudar de conta: os eventos do agente antigo são ignorados. */
  replaced?: boolean;
  /** Id ACP já registrado na atribuição de uso das contas. */
  recordedAcp?: string;
  /** Termina quando o worktree foi guardado no branch e apagado. */
  released?: Promise<void>;
  /** O que o usuário já fez com cada arquivo mudado (RF-107). */
  readonly resolutions: Map<string, 'aplicado' | 'rejeitado' | 'conflito'>;
  /** Modo de permissão; muda com `agents.setPermissions`. */
  mode: PermissionPolicyName;
  /** A conversa, montada dos eventos, para quem abre a sessão depois (celular, IDE recarregada). */
  readonly transcript: Transcript;
  /** Último evento aplicado na conversa. */
  lastEvent?: string;
  /** Último aviso de limite do agente; limpo quando ele volta a trabalhar. */
  limite?: AgentLimitInfo | undefined;
  activityAt: string;
  endedAt?: string;
  recovery?: AgentRecoveryInfo | undefined;
  autoResume: boolean;
  /** Resposta da vez atual; avaliada inteira para não confundir código com um aviso. */
  turnOutput: string;
}

/** Como reabrir uma sessão: depois de encerrar (revive) ou com outra conta. */
interface ReopenOptions {
  readonly id: string;
  readonly record: StoredSession;
  readonly profile: AgentProfile;
  /** Conversa guardada, para o histórico quando o agente não carrega a própria sessão. */
  readonly entries: readonly AgentTranscriptEntry[];
  readonly worktree?: Worktree | undefined;
  readonly slot: ClaudeAccountSlot | undefined;
  /** A sessão de antes, cuja conversa da memória continua. */
  readonly previous?: Session | undefined;
  /** Aviso do `agent.state`, a partir de como a conversa voltou (sessão do agente ou histórico). */
  readonly reason: (fromSession: boolean) => string;
  /** Estado anunciado como anterior no aviso; sem ele, o do registro. */
  readonly previousState?: AgentState;
}

/** Servidor do config.yaml ou da biblioteca de MCPs no formato dos adaptadores. */
function mcpRef(server: McpSessionServer): McpServerRef {
  return isMcpHttpServer(server)
    ? { type: 'http', name: server.nome, url: server.url, headers: server.headers ?? {} }
    : {
        name: server.nome,
        command: server.comando,
        args: server.args ?? [],
        env: server.env ?? {},
      };
}

/**
 * Sessões de agente do Core (módulo `runtime`, SDD 6.2). Cada evento do
 * adaptador vira um evento no barramento, com a sessão como `subject`.
 */
export class AgentRuntime {
  private readonly sessions = new Map<string, Session>();
  /** Sessões reidratadas do disco: sem agente rodando, até alguém mandar uma mensagem. */
  private readonly dormant = new Map<string, StoredSession>();
  private readonly reviving = new Map<string, Promise<Session>>();
  private readonly resuming = new Map<string, Promise<void>>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly recoveryVersions = new Map<string, number>();
  private closing = false;
  /** Sessões reabrindo com outra conta; mensagens e retomadas esperam por elas. */
  private readonly switching = new Map<string, Promise<Session>>();
  /** Paradas pedidas durante uma troca de conta: valem para o agente novo. */
  private readonly stopRequests = new Map<string, StopReason>();
  /** Troca de conta de quem estava no meio de uma vez: acontece quando a vez termina. */
  private readonly pendingSwitch = new Map<
    string,
    { readonly slot: ClaudeAccountSlot | undefined }
  >();
  /** Pedidos de permissão sem resposta, por sessão: do agente e do Core (Approvals). */
  private readonly asking = new Map<string, Map<string, AgentPermissionEventData>>();
  private readonly adapterFor: (profile: AgentProfile) => AgentAdapter;

  constructor(
    private readonly bus: EventBus,
    private readonly options: AgentRuntimeOptions = {},
  ) {
    this.adapterFor = options.adapterFor ?? ((profile) => adapterForProfile(profile));
    // Troca de conta adiada: quando a vez acaba (ou a sessão encerra), ela acontece.
    bus.subscribe(['agent.state'], (event) => {
      if (!this.pendingSwitch.has(event.subject)) return;
      const id = event.subject;
      setImmediate(() => {
        this.applyPending(id);
      });
    });
    bus.subscribe(['agent.permission', 'agent.state'], (event) => {
      if (event.topic === 'agent.permission') {
        const data = event.data as AgentPermissionEventData;
        const pending =
          this.asking.get(event.subject) ?? new Map<string, AgentPermissionEventData>();
        pending.set(data.id, data);
        this.asking.set(event.subject, pending);
        return;
      }
      const { state, previous } = event.data as AgentStateEventData;
      const pending = this.asking.get(event.subject);
      if (!pending) return;
      if (isFinalAgentState(state)) {
        this.asking.delete(event.subject);
      } else if (previous === 'aguardando-permissão' && state !== previous) {
        // O agente seguiu: os pedidos dele foram respondidos; os do Core (fakl-) seguem até a resposta.
        for (const id of [...pending.keys()]) if (!id.startsWith('fakl-')) pending.delete(id);
      }
    });
    // A conversa vai para o disco do mesmo jeito que o chat a monta: pelos eventos.
    bus.subscribe(JOURNAL_TOPICS, (event) => {
      const store = this.options.store;
      const session = this.sessions.get(event.subject);
      if (!store || !session || !this.persisted(session)) return;
      if (event.topic === 'agent.state') {
        const { state, previous } = event.data as AgentStateEventData;
        const resumed = isFinalAgentState(previous) && !isFinalAgentState(state);
        if (!JOURNAL_STATES.has(state) && !resumed) return;
      }
      store.event(event.subject, event.topic, event.data);
    });
    // A conversa e os horários de cada sessão, para quem abre a sessão depois.
    bus.subscribe(
      [...TRANSCRIPT_TOPICS, 'agent.file', 'agent.mode', 'agent.options', 'cost.update'],
      (event) => {
        const session = this.sessions.get(event.subject);
        if (!session) return;
        session.activityAt = event.ts;
        if (event.topic === 'agent.state') {
          const { state } = event.data as AgentStateEventData;
          if (isFinalAgentState(state)) session.endedAt ??= event.ts;
          // O limite vale até o agente voltar a trabalhar (ou encerrar).
          if (WORKING.has(state) || isFinalAgentState(state)) session.limite = undefined;
        } else if (event.topic === 'agent.output') {
          const { kind, text } = event.data as AgentOutputEventData;
          if (kind === 'error' && isLimitText(text)) {
            session.limite = { motivo: limitReason(text), em: event.ts };
          }
        }
        if (!(TRANSCRIPT_TOPICS as readonly string[]).includes(event.topic)) return;
        for (const index of session.transcript.apply(event)) {
          const item = session.transcript.items[index];
          if (item && 'text' in item && item.text.length > ITEM_MAX_CHARS) {
            session.transcript.items[index] = {
              ...item,
              text: `…${item.text.slice(-ITEM_MAX_CHARS)}`,
            };
          }
        }
        session.transcript.trim(TRANSCRIPT_MAX_ITEMS);
        session.lastEvent = event.id;
      },
    );
  }

  /** Toda conversa, inclusive de tarefa, vai para o diário quando ele está configurado. */
  private persisted(session: Session): boolean {
    return this.options.store !== undefined && !session.replaced;
  }

  /** Pedidos de permissão esperando resposta, para a CLI e quem conecta depois. */
  pendingPermissions(): AgentPermissionRequest[] {
    return [...this.asking].flatMap(([sessionId, pending]) =>
      [...pending.values()].map((data) => ({ sessionId, ...data })),
    );
  }

  /** Perfis em vigor agora. */
  profileList(): readonly AgentProfile[] {
    return this.profiles;
  }

  private get profiles(): readonly AgentProfile[] {
    const profiles = this.options.profiles ?? defaultProfiles();
    return typeof profiles === 'function' ? profiles() : profiles;
  }

  register(router: Router): void {
    router.register('agents.detect', () => this.detect());
    router.register('agents.start', (params, context) => {
      const p = objectParams(params);
      // Do celular, só o essencial: prompt de sistema e servidores SSH ficam com a IDE.
      if (context.principal?.startsWith('remote:')) {
        delete p.systemPrompt;
        delete p.remotas;
      }
      return this.start(p);
    });
    router.register('agents.list', () => this.list());
    router.register('agents.send', async (params) => {
      const p = objectParams(params);
      const exibir = typeof p.exibir === 'string' && p.exibir.trim() ? p.exibir : undefined;
      // Sessão encerrada ou guardada em disco volta a rodar antes da mensagem.
      await this.live(stringParam(p, 'sessionId'));
      // Responde na hora; a resposta do agente chega pelos eventos.
      this.send(stringParam(p, 'sessionId'), stringParam(p, 'message'), exibir);
      return null;
    });
    router.register('agents.transcript', (params) => {
      const p = objectParams(params);
      const limit =
        typeof p.limit === 'number' && p.limit > 0 ? Math.min(p.limit, 2_000) : undefined;
      return this.transcript(stringParam(p, 'sessionId'), limit);
    });
    router.register('agents.pause', async (params) => {
      const id = stringParam(objectParams(params), 'sessionId');
      // Durante uma troca de conta, a pausa vale para o agente novo.
      await this.switching.get(id)?.catch(() => undefined);
      await this.session({ sessionId: id }).handle.pause();
      return null;
    });
    router.register('agents.resume', async (params) => {
      const id = stringParam(objectParams(params), 'sessionId');
      await this.resume(id);
      return null;
    });
    router.register('agents.setAutoResume', async (params) => {
      const p = objectParams(params);
      if (typeof p.automatica !== 'boolean')
        throw RpcError.invalidParams(l10n.t('automatica must be a boolean'));
      await this.setAutoResume(stringParam(p, 'sessionId'), p.automatica);
      return null;
    });
    router.register('agents.stop', async (params) => {
      const id = stringParam(objectParams(params), 'sessionId');
      if (!this.dormant.has(id)) this.session({ sessionId: id });
      await this.stop(id, 'usuário');
      return null;
    });
    router.register('agents.forget', (params) =>
      this.forget(stringParam(objectParams(params), 'sessionId')),
    );
    router.register('agents.permission', async (params) => {
      const p = objectParams(params);
      if (typeof p.allow !== 'boolean')
        throw RpcError.invalidParams(l10n.t('allow must be a boolean'));
      // `sempre` é opcional: clientes antigos mandam só `allow`.
      await this.respondPermission(
        stringParam(p, 'sessionId'),
        stringParam(p, 'id'),
        p.allow,
        p.allow && p.sempre === true,
      );
      return null;
    });
    router.register('agents.permissions', () => this.pendingPermissions());
    router.register('agents.setOption', async (params) => {
      const p = objectParams(params);
      const value = p.value;
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        throw RpcError.invalidParams(l10n.t('value must be text or a boolean'));
      }
      await this.switching.get(stringParam(p, 'sessionId'))?.catch(() => undefined);
      const dormant = this.dormant.get(stringParam(p, 'sessionId'));
      if (dormant) {
        await this.setDormantOption(dormant, stringParam(p, 'id'), value);
        return null;
      }
      const session = this.session(p);
      try {
        await session.handle.setOption(stringParam(p, 'id'), value);
      } catch (error) {
        throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
      }
      return null;
    });
    router.register('agents.setPermissions', async (params) => {
      const p = objectParams(params);
      const mode = p.permissions;
      if (!isPermissionMode(mode)) {
        throw RpcError.invalidParams(
          l10n.t('permissions must be {0}', PERMISSION_MODES.join(', ')),
        );
      }
      await this.setPermissions(stringParam(p, 'sessionId'), mode);
      return null;
    });
    router.register('agents.diff', (params) => this.diff(objectParams(params)));
    router.register('agents.fileContent', (params) => this.fileContent(objectParams(params)));
    router.register('agents.applyFiles', (params) => this.applyFiles(objectParams(params)));
    router.register('agents.rejectFiles', (params) => this.rejectFiles(objectParams(params)));
  }

  /** Arquivos que o agente mudou no worktree dele (RF-107). */
  async diff(p: Record<string, unknown>): Promise<AgentDiffResult> {
    const session = this.session(p);
    const worktree = this.worktreeOf(session);
    await session.released;
    const files = await changedFiles(worktree);
    return {
      branch: worktree.branch,
      base: worktree.base,
      files: files.map((file): AgentChangedFile => {
        const resolution = session.resolutions.get(file.path);
        return resolution ? { ...file, resolution } : file;
      }),
    };
  }

  async fileContent(p: Record<string, unknown>): Promise<AgentFileContentResult> {
    const session = this.session(p);
    const side = p.side === 'base' ? 'base' : 'agente';
    const content = await fileContent(this.worktreeOf(session), stringParam(p, 'path'), side);
    return content ? { base64: content.toString('base64') } : {};
  }

  /** Leva as mudanças desses arquivos para a pasta de onde o worktree saiu. */
  async applyFiles(p: Record<string, unknown>): Promise<AgentApplyResult> {
    const session = this.session(p);
    const worktree = this.worktreeOf(session);
    await session.released;
    const result = await applyFiles(worktree, stringArrayParam(p, 'paths'));
    for (const path of result.applied) session.resolutions.set(path, 'aplicado');
    for (const path of result.conflicts) session.resolutions.set(path, 'conflito');
    this.options.log?.(
      l10n.t(
        'session {0}: {1} file(s) applied, {2} with conflicts',
        session.id,
        String(result.applied.length),
        String(result.conflicts.length),
      ),
    );
    return result;
  }

  async rejectFiles(p: Record<string, unknown>): Promise<null> {
    const session = this.session(p);
    const worktree = this.worktreeOf(session);
    await session.released;
    const paths = stringArrayParam(p, 'paths');
    await rejectFiles(worktree, paths);
    for (const path of paths) session.resolutions.set(path, 'rejeitado');
    return null;
  }

  private worktreeOf(session: Session): Worktree {
    if (!session.worktree) {
      throw RpcError.invalidParams(
        l10n.t(
          'this session works directly in the open folder; the changes are already in your files',
        ),
      );
    }
    return session.worktree;
  }

  async detect(): Promise<AgentProfileAvailability[]> {
    return Promise.all(
      this.profiles.map(async (profile) => ({
        id: profile.id,
        nome: profile.nome,
        provedor: profile.provedor,
        availability: await this.adapterFor(profile).detect(),
      })),
    );
  }

  async start(p: Record<string, unknown>): Promise<AgentStartResult> {
    const permissions = p.permissions;
    if (permissions !== undefined && !isPermissionMode(permissions)) {
      throw RpcError.invalidParams(l10n.t('permissions must be {0}', PERMISSION_MODES.join(', ')));
    }
    const cwd = stringParam(p, 'cwd');
    // Pela IDE o worktree é só uma preferência: numa pasta sem git (ou sem
    // nenhum commit) o agente trabalha direto nela em vez de não subir.
    const worktree = p.worktree === true && (await isGitRepo(cwd));
    if (p.contaClaude !== undefined && !isClaudeAccountSlot(p.contaClaude)) {
      throw RpcError.invalidParams(l10n.t('contaClaude must be 1, 2 or 3'));
    }
    const remote = remoteContext(parseRemoteRoots(p.remotas));
    const extra = [
      this.options.sessionPrompt?.() ?? '',
      remote,
      typeof p.systemPrompt === 'string' ? p.systemPrompt : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.launch({
      profileId: stringParam(p, 'profileId'),
      cwd,
      worktree,
      ...(permissions ? { permissions } : {}),
      ...(isClaudeAccountSlot(p.contaClaude) ? { claudeAccount: p.contaClaude } : {}),
      ...(extra ? { systemPrompt: extra } : {}),
    });
  }

  /** Prepara o ambiente do agente; uma falha aqui não impede a sessão. */
  private async prepare(
    profile: AgentProfile,
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      await this.options.beforeStart?.(profile, env);
    } catch (error) {
      this.options.log?.(l10n.t('setup of agent {0} failed: {1}', profile.id, String(error)));
    }
  }

  /** Inicia uma sessão; usado pela API e pelo orquestrador. */
  async launch(options: LaunchOptions): Promise<AgentStartResult> {
    const profile = this.profiles.find((candidate) => candidate.id === options.profileId);
    if (!profile) throw RpcError.notFound(l10n.t('profile {0} does not exist', options.profileId));
    this.checkGuard(profile);
    const { cwd, taskId } = options;
    if (!isAbsolute(cwd)) throw RpcError.invalidParams(l10n.t('cwd must be an absolute path'));
    const mode =
      options.permissions ??
      profile.permissoes ??
      this.options.defaultPermissions?.() ??
      'perguntar';
    const slot = usesClaudeAccount(profile)
      ? await this.options.claudeAccounts?.resolve(options.claudeAccount)
      : undefined;
    const account = slot ? this.options.claudeAccounts?.ref(slot) : undefined;

    const id = ulid();
    const mcpServers = [
      ...(this.options.mcpServers?.() ?? []).map(mcpRef),
      ...((options.extraMcp ?? this.options.sessionMcp)?.(id, profile) ?? []),
    ];
    let worktree: Worktree | undefined;
    if (options.worktree) {
      try {
        worktree = await createWorktree({
          repo: cwd,
          home: this.options.home ?? homedir(),
          sessionId: id,
          ...(taskId ? { taskId } : {}),
          ...(typeof options.worktree === 'object' ? { base: options.worktree.base } : {}),
        });
      } catch (error) {
        throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
      }
    }
    const agentCwd = worktree?.path ?? cwd;
    const systemPrompt = composePrompt(
      profile,
      options.systemPrompt,
      worktree ? { tree: worktree, inTask: taskId !== undefined } : undefined,
    );

    const env = {
      FAKL_AGENT_SESSION: id,
      ...(slot ? this.options.claudeAccounts?.env(slot) : {}),
    };
    await this.prepare(profile, env);
    let handle: AgentHandle;
    try {
      handle = await this.adapterFor(profile).start({
        profile,
        cwd: agentCwd,
        permissions: adapterPolicy(mode),
        env: { ...env, ...this.options.providerEnv?.(profile) },
        mcpServers,
        ...(systemPrompt ? { systemPrompt } : {}),
      });
    } catch (error) {
      if (worktree) await this.release(id, profile, worktree);
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
    const session: Session = {
      id,
      profile,
      ...(taskId ? { taskId } : {}),
      cwd: agentCwd,
      handle,
      ...(systemPrompt ? { systemPrompt } : {}),
      createdAt: new Date().toISOString(),
      resolutions: new Map(),
      mode,
      ...(account ? { account } : {}),
      ...(options.extraMcp ? { extraMcp: options.extraMcp } : {}),
      ...(worktree ? { worktree } : {}),
      transcript: new Transcript(),
      activityAt: new Date().toISOString(),
      autoResume: false,
      turnOutput: '',
    };
    this.sessions.set(id, session);
    this.attach(session);
    this.scheduleSave(session);
    this.options.log?.(l10n.t('agent {0} started ({1}) in {2}', profile.id, id, agentCwd));
    if (usesClaudeAccount(profile) && options.claudeAccount === undefined) {
      // A conta ativa mudou enquanto o agente subia: a troca não o viu, então ele troca agora.
      const current = await this.options.claudeAccounts?.resolve();
      if (current !== slot && this.sessions.get(id) === session) {
        this.pendingSwitch.set(id, { slot: current });
        this.applyPending(id);
      }
    }
    return {
      sessionId: id,
      ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
    };
  }

  /**
   * Mensagem para uma sessão, respeitando o teto diário. Não espera a resposta.
   * Vira o evento `agent.prompt`, com `exibir` no lugar do texto quando vem.
   */
  send(sessionId: string, message: string, exibir?: string): void {
    const switching = this.switching.get(sessionId);
    if (switching) {
      // Reabrindo com outra conta: a mensagem vai para o agente novo.
      switching.then(
        () => {
          this.send(sessionId, message, exibir);
        },
        () => undefined,
      );
      return;
    }
    const session = this.session({ sessionId });
    this.checkGuard(session.profile);
    session.turnOutput = '';
    // Uma sessão encerrada não recebe nada; a conversa não mostra o que não foi.
    if (!isFinalAgentState(session.handle.state)) {
      this.recordUser(session, exibir ?? message);
      const text = exibir ?? message;
      this.bus.publish<AgentPromptEventData>('agent.prompt', sessionId, {
        text: this.options.redact?.(text) ?? text,
      });
    }
    session.handle.send(message).catch((error: unknown) => {
      if (session.replaced || this.closing || this.sessions.get(sessionId) !== session) return;
      const recovery = parseSessionLimit(error instanceof Error ? error.message : String(error));
      if (recovery && !session.recovery) this.waitForLimit(session, recovery);
    });
  }

  /**
   * Os últimos itens da conversa, até `limit` e até caberem numa mensagem do
   * controle remoto; um item grande demais sozinho vai cortado no começo.
   */
  async transcript(
    sessionId: string,
    limit = TRANSCRIPT_DEFAULT_LIMIT,
  ): Promise<AgentTranscriptResult> {
    const session = this.sessions.get(sessionId);
    let all: readonly ChatItem[];
    if (session) {
      all = session.transcript.items;
    } else if (this.dormant.has(sessionId)) {
      // Guardada em disco, sem agente: monta do diário, como a IDE fazia.
      const entries = (await this.options.store?.transcript(sessionId)) ?? [];
      all = Transcript.replay(sessionId, entries).items;
    } else {
      throw RpcError.notFound(l10n.t('session {0} does not exist', sessionId));
    }
    const items: ChatItem[] = [];
    let budget = TRANSCRIPT_MAX_BYTES;
    for (let i = all.length - 1; i >= 0 && items.length < limit; i--) {
      const item = all[i];
      if (!item) continue;
      // Em bytes do JSON: acentos, aspas e quebras de linha pesam mais que um caractere.
      const size = Buffer.byteLength(JSON.stringify(item), 'utf8');
      if (size > budget) {
        if (items.length === 0 && 'text' in item) {
          // Até 4 bytes por caractere, mais os escapes: corta com folga.
          items.push({ ...item, text: `…${item.text.slice(-Math.floor(budget / 6))}` });
        }
        break;
      }
      budget -= size;
      items.push(item);
    }
    items.reverse();
    return {
      items,
      omitidos: all.length - items.length,
      ...(session?.lastEvent ? { ultimoEvento: session.lastEvent } : {}),
    };
  }

  /**
   * Para a sessão. No meio de uma troca de conta, a parada vale para o agente
   * novo (ou impede que ele suba) e só volta com a sessão encerrada; uma troca
   * adiada não reabre a sessão depois.
   */
  async stop(sessionId: string, reason: StopReason): Promise<void> {
    this.cancelRecoveryTimer(sessionId);
    this.recoveryVersions.set(sessionId, (this.recoveryVersions.get(sessionId) ?? 0) + 1);
    this.pendingSwitch.delete(sessionId);
    const switching = this.switching.get(sessionId) ?? this.reviving.get(sessionId);
    if (switching) {
      this.stopRequests.set(sessionId, reason);
      await switching.catch(() => undefined);
      this.stopRequests.delete(sessionId);
    }
    const session = this.sessions.get(sessionId);
    if (session?.recovery) this.clearRecovery(session);
    const dormant = this.dormant.get(sessionId);
    if (dormant?.retomada) {
      const rest = { ...dormant };
      delete rest.retomada;
      await this.updateDormant(rest);
      this.recoveryEvent(sessionId, null);
    }
    if (session && !isFinalAgentState(session.handle.state)) await session.handle.stop(reason);
  }

  async pause(sessionId: string): Promise<void> {
    await this.switching.get(sessionId)?.catch(() => undefined);
    const session = this.sessions.get(sessionId);
    if (session && WORKING.has(session.handle.state)) await session.handle.pause();
  }

  async resume(sessionId: string): Promise<void> {
    const pending = this.resuming.get(sessionId);
    if (pending) return pending;
    this.cancelRecoveryTimer(sessionId);
    const version = this.recoveryVersions.get(sessionId) ?? 0;
    const run = this.resumeNow(sessionId, version);
    this.resuming.set(sessionId, run);
    const clear = (): void => {
      this.resuming.delete(sessionId);
    };
    run.then(clear, clear);
    return run;
  }

  private async resumeNow(id: string, version: number): Promise<void> {
    const session = await this.live(id);
    if (this.closing || version !== (this.recoveryVersions.get(id) ?? 0)) return;
    this.checkGuard(session.profile);
    if (session.recovery) {
      // A pausa ACP feita no fim da vez não enfileira a continuação própria do adaptador.
      // O orquestrador precisa ver recovery=null antes de qualquer sinal de execução.
      this.clearRecovery(session);
      await session.handle.resume();
      if (version !== (this.recoveryVersions.get(id) ?? 0) || this.isClosing()) return;
      this.send(id, resumeAfterLimit());
    } else {
      await session.handle.resume();
    }
  }

  /** Espera atual por limite, inclusive quando só existe o registro do disco. */
  recoveryOf(sessionId: string): AgentRecoveryInfo | undefined {
    return this.sessions.get(sessionId)?.recovery ?? this.dormant.get(sessionId)?.retomada;
  }

  /** Opt-in persistente; desativar cancela imediatamente a espera automática. */
  async setAutoResume(sessionId: string, automatica: boolean): Promise<void> {
    await this.switching.get(sessionId)?.catch(() => undefined);
    const session = this.sessions.get(sessionId);
    const record = this.dormant.get(sessionId);
    if (!session && !record)
      throw RpcError.notFound(l10n.t('session {0} does not exist', sessionId));
    if (session) {
      session.autoResume = automatica;
      if (session.recovery) session.recovery = { ...session.recovery, automatica };
      await this.saveNow(session);
    } else if (record) {
      await this.updateDormant({
        ...record,
        retomadaAutomatica: automatica,
        ...(record.retomada ? { retomada: { ...record.retomada, automatica } } : {}),
      });
    }
    const recovery = this.recoveryOf(sessionId);
    if (recovery) this.recoveryEvent(sessionId, recovery);
    this.scheduleRecovery(sessionId);
  }

  private recoveryEvent(id: string, retomada: AgentRecoveryInfo | null): void {
    this.bus.publish<AgentRecoveryEventData>('agent.recovery', id, { retomada });
  }

  private clearRecovery(session: Session): void {
    this.cancelRecoveryTimer(session.id);
    session.recovery = undefined;
    session.turnOutput = '';
    this.recoveryEvent(session.id, null);
    this.scheduleSave(session);
  }

  private cancelRecoveryTimer(id: string): void {
    clearTimeout(this.recoveryTimers.get(id));
    this.recoveryTimers.delete(id);
  }

  private scheduleRecovery(id: string): void {
    this.cancelRecoveryTimer(id);
    const recovery = this.recoveryOf(id);
    if (this.closing || !recovery?.automatica) return;
    const reset = recovery.retomarEm ? Date.parse(recovery.retomarEm) : NaN;
    const delay = Number.isFinite(reset)
      ? Math.max(MIN_RESUME_DELAY_MS, reset - Date.now())
      : UNKNOWN_RESET_MS;
    const timer = setTimeout(
      () => {
        this.recoveryTimers.delete(id);
        void this.resume(id)
          .catch((error: unknown) => {
            this.options.log?.(l10n.t('automatic resume of {0}: {1}', id, String(error)));
          })
          .finally(() => {
            if (this.recoveryOf(id) && !this.recoveryTimers.has(id)) this.scheduleRecovery(id);
          });
      },
      Math.min(delay, 2_147_483_647),
    );
    timer.unref();
    this.recoveryTimers.set(id, timer);
  }

  stateOf(sessionId: string): AgentState | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.stateOfSession(session) : this.dormant.get(sessionId)?.estado;
  }

  /** Quem reabre com outra conta aparece preparando, não parado: a sessão continua. */
  private stateOfSession(session: Session): AgentState {
    return this.switching.has(session.id)
      ? 'preparando'
      : session.recovery
        ? 'pausado'
        : session.handle.state;
  }

  usageOf(sessionId: string): Usage | undefined {
    return this.sessions.get(sessionId)?.handle.usage();
  }

  /** Worktree da sessão; o branch continua válido depois de o worktree ser apagado. */
  /** Pasta onde a sessão trabalha (o worktree, quando há). */
  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  worktree(sessionId: string): Worktree | undefined {
    return this.sessions.get(sessionId)?.worktree;
  }

  /** Espera o worktree ser guardado no branch, se a sessão já terminou. */
  async settled(sessionId: string): Promise<void> {
    await this.switching.get(sessionId)?.catch(() => undefined);
    await this.sessions.get(sessionId)?.released;
  }

  /** Guarda o trabalho do agente no branch dele e apaga o worktree. */
  private async release(id: string, profile: AgentProfile, worktree: Worktree): Promise<void> {
    try {
      await removeWorktree(worktree, l10n.t('fakl: work by {0} (session {1})', profile.nome, id));
    } catch (error) {
      this.options.log?.(
        l10n.t('could not remove the worktree {0}: {1}', worktree.path, String(error)),
      );
    }
  }

  list(): AgentSessionInfo[] {
    const live = [...this.sessions.values()].map((s): AgentSessionInfo => {
      const answer = s.transcript.lastAnswer();
      // Só o fim da resposta: a lista é pedida a cada evento.
      const fala = answer ? lastLine(answer.slice(-2_000)) : '';
      const state = this.stateOfSession(s);
      return {
        sessionId: s.id,
        profileId: s.profile.id,
        nome: s.profile.nome,
        provedor: s.profile.provedor,
        cwd: s.cwd,
        ...(s.worktree ? { pastaOrigem: s.worktree.repoRoot } : {}),
        state,
        usage: s.handle.usage(),
        ...(s.worktree ? { worktree: { path: s.worktree.path, branch: s.worktree.branch } } : {}),
        permissoes: s.mode,
        ...(s.account ? { contaClaude: s.account } : {}),
        opcoes: s.handle.sessionOptions(),
        ...(s.taskId ? { taskId: s.taskId } : {}),
        ...(s.recovery ? { retomada: s.recovery } : {}),
        iniciadaEm: s.createdAt,
        atividadeEm: s.activityAt,
        ...(s.endedAt ? { encerradaEm: s.endedAt } : {}),
        ...(fala ? { ultimaFala: fala } : {}),
        ...(s.title ? { titulo: s.title } : {}),
        ...(s.limite ? { limite: s.limite } : {}),
        // Encerrada, mas uma mensagem nova abre o agente de novo.
        ...(isFinalAgentState(state) && this.persisted(s) ? { retomavel: true } : {}),
      };
    });
    const accounts = this.options.claudeAccounts;
    const providers = new Map(this.profiles.map((profile) => [profile.id, profile.provedor]));
    const providerOf = (profileId: string): { provedor?: string } => {
      const provedor = providers.get(profileId);
      return provedor ? { provedor } : {};
    };
    const stored = [...this.dormant.values()].map((r): AgentSessionInfo => ({
      sessionId: r.id,
      profileId: r.profileId,
      nome: r.nome,
      ...providerOf(r.profileId),
      cwd: r.cwd,
      ...(r.worktree ? { pastaOrigem: r.worktree.repoRoot } : {}),
      state: r.estado,
      usage: r.usage,
      ...(r.worktree ? { worktree: { path: r.worktree.path, branch: r.worktree.branch } } : {}),
      permissoes: r.permissoes,
      ...(r.contaClaude && accounts ? { contaClaude: accounts.ref(r.contaClaude) } : {}),
      opcoes: r.opcoes,
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.retomada ? { retomada: r.retomada } : {}),
      ...(r.titulo ? { titulo: r.titulo } : {}),
      retomavel: true,
      iniciadaEm: r.criadoEm,
      atividadeEm: r.atualizadoEm,
      encerradaEm: r.atualizadoEm,
    }));
    return [...live, ...stored];
  }

  private checkGuard(profile: AgentProfile): void {
    const reason = this.options.guard?.(profile);
    if (reason) throw new RpcError(FaklErrorCode.LimitExceeded, reason);
  }

  /** Slot do Claude de cada sessão que usa uma das contas da IDE (ADR 0021). */
  claudeSlots(): ReadonlyMap<string, ClaudeAccountSlot> {
    return new Map(
      [...this.sessions.values()].flatMap((s) =>
        s.account ? [[s.id, s.account.slot] as const] : [],
      ),
    );
  }

  /** Perfil e tarefa de uma sessão, para a contabilidade de custos. */
  sessionProfile(sessionId: string): { profile: AgentProfile; taskId?: string } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const record = this.dormant.get(sessionId);
      const profile = record && this.profiles.find((p) => p.id === record.profileId);
      return profile ? { profile, ...(record.taskId ? { taskId: record.taskId } : {}) } : undefined;
    }
    return { profile: session.profile, ...(session.taskId ? { taskId: session.taskId } : {}) };
  }

  /** Pausa as sessões deste provedor que estão trabalhando; devolve quais. */
  pauseProvider(provedor: string): string[] {
    const paused: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.profile.provedor !== provedor || !WORKING.has(session.handle.state)) continue;
      paused.push(session.id);
      session.handle.pause().catch(() => undefined);
    }
    return paused;
  }

  async respondPermission(
    sessionId: string,
    id: string,
    allow: boolean,
    always = false,
  ): Promise<void> {
    if (!this.options.approvals?.respond(sessionId, id, allow)) {
      await this.session({ sessionId }).handle.respondPermission(id, allow, always);
    }
    this.asking.get(sessionId)?.delete(id);
    this.bus.publish<AgentAnswerEventData>('agent.answer', sessionId, { id, allow });
  }

  /**
   * Troca o modo de permissão da sessão. Em aprovar tudo ou autopilot, libera
   * os pedidos do agente que estavam esperando; os do próprio Core (SSH,
   * Hostinger, segredos) continuam esperando você (ADR 0016).
   */
  async setPermissions(sessionId: string, mode: PermissionPolicyName): Promise<void> {
    // Durante uma troca de conta, o modo vale para o agente novo, não para o que está saindo.
    await this.switching.get(sessionId)?.catch(() => undefined);
    const dormant = this.dormant.get(sessionId);
    if (dormant) {
      // Sem agente rodando: o modo vale quando a sessão for retomada.
      await this.updateDormant({ ...dormant, permissoes: mode });
      this.bus.publish<AgentModeEventData>('agent.mode', sessionId, { permissoes: mode });
      return;
    }
    const session = this.session({ sessionId });
    session.mode = mode;
    this.scheduleSave(session);
    session.handle.setPermissions(adapterPolicy(mode));
    this.bus.publish<AgentModeEventData>('agent.mode', sessionId, { permissoes: mode });
    if (approvesAll(mode)) {
      const waiting = [...(this.asking.get(sessionId)?.keys() ?? [])];
      for (const id of waiting.filter((id) => !id.startsWith('fakl-'))) {
        await this.respondPermission(sessionId, id, true).catch(() => undefined);
      }
    }
  }

  modeOf(sessionId: string): PermissionPolicyName | undefined {
    return this.sessions.get(sessionId)?.mode ?? this.dormant.get(sessionId)?.permissoes;
  }

  /** Encerra todos os agentes; usado ao fechar a IDE. */
  async stopAll(): Promise<void> {
    this.closing = true;
    for (const id of this.recoveryTimers.keys()) this.cancelRecoveryTimer(id);
    this.pendingSwitch.clear();
    await Promise.all(
      [...this.switching.values(), ...this.reviving.values(), ...this.resuming.values()].map(
        (run) => run.catch(() => undefined),
      ),
    );
    await Promise.all(
      [...this.sessions.values()].map((s) => s.handle.stop('ide-fechando').catch(() => undefined)),
    );
    await Promise.all([...this.sessions.values()].flatMap((s) => (s.released ? [s.released] : [])));
    // Estado final de cada sessão no disco: na próxima abertura elas voltam retomáveis.
    await Promise.all([...this.sessions.values()].map((s) => this.saveNow(s)));
    await this.options.store?.flush();
  }

  private session(p: Record<string, unknown>): Session {
    const id = stringParam(p, 'sessionId');
    const session = this.sessions.get(id);
    if (!session && this.dormant.has(id)) {
      throw RpcError.invalidParams(
        l10n.t('the session has ended; send a message in the chat to resume it'),
      );
    }
    if (!session) throw RpcError.notFound(l10n.t('session {0} does not exist', id));
    return session;
  }

  /** Liga o handle ao barramento, ao worktree e ao disco. */
  private attach(session: Session): void {
    const { id, profile, worktree } = session;
    this.recordAccount(session);
    session.handle.onEvent((event) => {
      // O agente antigo de uma troca de conta sai calado: a sessão e o worktree seguem.
      if (session.replaced) return;
      if (event.type === 'output' && event.kind === 'message') {
        session.turnOutput = (session.turnOutput + event.text).slice(0, ITEM_MAX_CHARS);
      }
      if (event.type === 'error' && !this.closing) {
        const recovery = parseSessionLimit(event.message);
        if (recovery && !session.recovery) this.waitForLimit(session, recovery);
      }
      if (event.type === 'state' && !this.closing) {
        if (!session.recovery && (IDLE.has(event.state) || isFinalAgentState(event.state))) {
          const recovery = usesClaudeAccount(profile)
            ? parseSessionLimit(session.turnOutput, Date.now(), 'message')
            : undefined;
          if (recovery) this.waitForLimit(session, recovery);
        }
        // Uma vez que termina por limite não pode parecer resultado pronto ao orquestrador.
        if (
          session.recovery &&
          (IDLE.has(event.state) || isFinalAgentState(event.state) || event.state === 'pausado')
        ) {
          if (IDLE.has(event.state)) void session.handle.pause().catch(() => undefined);
          return;
        }
      }
      // O id ACP pode chegar só depois do início; uso e fala mantêm a atribuição viva.
      this.recordAccount(session, event.type === 'usage' || event.type === 'output');
      if (event.type === 'state') session.stopReason = event.reason;
      this.publish(id, event);
      if (event.type === 'state' || event.type === 'options' || event.type === 'usage') {
        this.scheduleSave(session);
      }
      if (event.type === 'state' && isFinalAgentState(event.state) && worktree) {
        session.released ??= this.release(id, profile, worktree);
      }
    });
  }

  private waitForLimit(session: Session, recovery: AgentRecoveryInfo): void {
    const previous = this.stateOfSession(session);
    session.recovery = {
      ...recovery,
      mensagem: this.options.redact?.(recovery.mensagem) ?? recovery.mensagem,
      automatica: session.autoResume,
    };
    this.recoveryEvent(session.id, session.recovery);
    this.bus.publish<AgentStateEventData>('agent.state', session.id, {
      state: 'pausado',
      previous,
      reason: session.recovery.mensagem,
    });
    this.scheduleSave(session);
    this.scheduleRecovery(session.id);
  }

  /** Conta da sessão do Claude Code no arquivo de atribuição, uma vez por id ACP. */
  private recordAccount(session: Session, active = false): void {
    const accounts = this.options.claudeAccounts;
    const acp = session.handle.remoteSessionId;
    if (!accounts?.recordSession || !acp || !usesClaudeAccount(session.profile)) return;
    if (session.recordedAcp === acp) {
      if (active) accounts.touchSession?.(acp);
      return;
    }
    session.recordedAcp = acp;
    accounts.recordSession(acp, session.account?.slot).catch((error: unknown) => {
      this.options.log?.(
        l10n.t('usage attribution of session {0}: {1}', session.id, String(error)),
      );
    });
  }

  private recordUser(session: Session, message: string): void {
    this.options.store?.user(session.id, message);
    if (!session.title) {
      session.title = titleOf(message);
      this.scheduleSave(session);
    }
  }

  /** O que vai para o disco; sem tokens, ambiente nem arquivos. */
  private snapshot(session: Session): StoredSession {
    const { handle, worktree } = session;
    const remoteId = handle.remoteSessionId;
    const prompt = session.systemPrompt
      ? (this.options.redact?.(session.systemPrompt) ?? session.systemPrompt)
      : undefined;
    return {
      versao: SESSION_FORMAT,
      id: session.id,
      profileId: session.profile.id,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      ...(session.recovery ? { retomada: session.recovery } : {}),
      retomadaAutomatica: session.autoResume,
      nome: session.profile.nome,
      ...(session.title ? { titulo: session.title } : {}),
      cwd: session.cwd,
      ...(worktree
        ? {
            worktree: {
              path: worktree.path,
              branch: worktree.branch,
              repoRoot: worktree.repoRoot,
              base: worktree.base,
            },
          }
        : {}),
      permissoes: session.mode,
      opcoes: handle.sessionOptions(),
      estado: session.recovery ? 'pausado' : handle.state,
      ...(session.stopReason ? { motivo: session.stopReason } : {}),
      ...(remoteId ? { acpSessionId: remoteId } : {}),
      ...(prompt ? { systemPrompt: prompt } : {}),
      ...(session.account ? { contaClaude: session.account.slot } : {}),
      usage: handle.usage(),
      criadoEm: session.createdAt,
      atualizadoEm: new Date().toISOString(),
    };
  }

  /** Junta mudanças seguidas (estado, custo, opções) numa gravação só. */
  private scheduleSave(session: Session): void {
    // A sessão substituída numa troca de conta não grava: o registro é o da nova.
    if (!this.persisted(session) || session.saveTimer || session.replaced) return;
    session.saveTimer = setTimeout(() => {
      session.saveTimer = undefined;
      void this.saveNow(session);
    }, SAVE_DELAY_MS);
    session.saveTimer.unref();
  }

  private async saveNow(session: Session): Promise<void> {
    const store = this.options.store;
    if (!store || !this.persisted(session) || session.replaced) return;
    clearTimeout(session.saveTimer);
    session.saveTimer = undefined;
    try {
      await store.save(this.snapshot(session));
    } catch (error) {
      this.options.log?.(l10n.t('could not save the session {0}: {1}', session.id, String(error)));
    }
  }

  /**
   * Lê do disco as sessões de antes de reiniciar. Elas voltam à lista e à Mesa
   * como encerradas e retomáveis; as que estavam trabalhando quando o Core
   * caiu (sem encerrar limpo) viram `interrompida`.
   */
  async load(): Promise<void> {
    const store = this.options.store;
    if (!store) return;
    for (const record of await store.load()) {
      let stored = record;
      if (!isFinalAgentState(record.estado) && !record.retomada) {
        stored = { ...record, estado: 'parado', motivo: 'interrompida' };
        // O worktree de quem caiu ficou com trabalho solto: guarda no branch, como no fim normal.
        if (record.worktree) {
          await removeWorktree(
            record.worktree,
            l10n.t('fakl: work by {0} (session {1}, interrupted)', record.nome, record.id),
          ).catch((error: unknown) => {
            this.options.log?.(
              l10n.t('orphan worktree {0}: {1}', record.worktree?.path ?? '', String(error)),
            );
          });
        }
        await store.save(stored).catch(() => undefined);
      }
      this.dormant.set(stored.id, stored);
      this.scheduleRecovery(stored.id);
    }
    if (this.dormant.size > 0) {
      this.options.log?.(l10n.t('{0} agent session(s) rehydrated', String(this.dormant.size)));
    }
  }

  /**
   * A sessão com um agente de pé: a que já roda, ou a reidratada/encerrada, que
   * é aberta de novo (ACP `session/load` ou `resume`; senão, com o histórico).
   */
  private async live(id: string): Promise<Session> {
    const switching = this.switching.get(id);
    if (switching) return switching;
    const session = this.sessions.get(id);
    if (session && !isFinalAgentState(session.handle.state)) {
      return session;
    }
    const pending = this.reviving.get(id);
    if (pending) return pending;
    const run = this.revive(id, session);
    this.reviving.set(id, run);
    const clear = (): void => {
      this.reviving.delete(id);
      this.applyPending(id);
    };
    run.then(clear, clear);
    return run;
  }

  private async revive(id: string, ended: Session | undefined): Promise<Session> {
    const store = this.options.store;
    let record: StoredSession | undefined;
    if (ended) {
      await ended.released;
      record = this.snapshot(ended);
    } else {
      record = this.dormant.get(id);
    }
    if (!record) throw RpcError.notFound(l10n.t('session {0} does not exist', id));
    const profile = this.profiles.find((candidate) => candidate.id === record.profileId);
    if (!profile) {
      throw RpcError.notFound(
        l10n.t("this session's profile {0} no longer exists", record.profileId),
      );
    }
    this.checkGuard(profile);
    let worktree: Worktree | undefined;
    if (record.worktree) {
      worktree = record.worktree;
      try {
        await reopenWorktree(worktree);
      } catch (error) {
        throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
      }
    } else if (
      !(await stat(record.cwd).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    ) {
      throw RpcError.invalidParams(
        l10n.t("this session's folder {0} no longer exists", record.cwd),
      );
    }
    // A conta com que a sessão rodava; sem ela, a ativa, como num agente novo.
    const accounts = this.options.claudeAccounts;
    const slot =
      accounts && usesClaudeAccount(profile)
        ? (record.contaClaude ?? (await accounts.resolve()))
        : undefined;
    try {
      return await this.reopen({
        id,
        record,
        profile,
        entries: store ? await store.transcript(id) : ended ? entriesOf(ended.transcript) : [],
        worktree,
        slot,
        previous: ended,
        reason: (fromSession) =>
          fromSession
            ? l10n.t('resumed with the agent session')
            : l10n.t('resumed with the conversation history'),
      });
    } catch (error) {
      if (worktree) await this.release(id, profile, worktree);
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
  }

  /** Abre de novo o agente de uma sessão, com a conversa de antes e a conta dada. */
  private async reopen(options: ReopenOptions): Promise<Session> {
    const { id, record, profile, worktree, slot, previous } = options;
    const history = historyContext(options.entries);
    const mcpServers = [
      ...(this.options.mcpServers?.() ?? []).map(mcpRef),
      ...((previous?.extraMcp ?? this.options.sessionMcp)?.(id, profile) ?? []),
    ];
    const accounts = this.options.claudeAccounts;
    const env = { FAKL_AGENT_SESSION: id, ...(slot ? accounts?.env(slot) : {}) };
    await this.prepare(profile, env);
    const handle = await this.adapterFor(profile).start({
      profile,
      cwd: record.cwd,
      permissions: adapterPolicy(record.permissoes),
      env: { ...env, ...this.options.providerEnv?.(profile) },
      mcpServers,
      ...(record.systemPrompt ? { systemPrompt: record.systemPrompt } : {}),
      resume: {
        ...(record.acpSessionId ? { sessionId: record.acpSessionId } : {}),
        ...(history ? { history } : {}),
      },
    });
    const account = slot ? accounts?.ref(slot) : undefined;
    const session: Session = {
      id,
      profile,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...(record.retomada ? { recovery: record.retomada } : {}),
      autoResume: record.retomadaAutomatica ?? record.retomada?.automatica ?? false,
      turnOutput: '',
      cwd: record.cwd,
      handle,
      ...(record.systemPrompt ? { systemPrompt: record.systemPrompt } : {}),
      createdAt: record.criadoEm,
      ...(record.titulo ? { title: record.titulo } : {}),
      resolutions:
        previous?.resolutions ?? new Map<string, 'aplicado' | 'rejeitado' | 'conflito'>(),
      mode: record.permissoes,
      ...(account ? { account } : {}),
      ...(previous?.extraMcp ? { extraMcp: previous.extraMcp } : {}),
      ...(worktree ? { worktree } : {}),
      // A conversa continua de onde parou: a da memória, ou a do diário em disco.
      transcript: previous?.transcript ?? Transcript.replay(id, options.entries),
      ...(previous?.lastEvent ? { lastEvent: previous.lastEvent } : {}),
      activityAt: new Date().toISOString(),
    };
    this.dormant.delete(id);
    this.sessions.set(id, session);
    this.attach(session);
    // As opções escolhidas antes (modelo, raciocínio, rápido) valem de novo, se o agente as oferece.
    for (const option of record.opcoes) {
      const current = handle.sessionOptions().find((o) => o.id === option.id);
      if (current && current.atual !== option.atual) {
        await handle.setOption(option.id, option.atual).catch(() => undefined);
      }
    }
    const fromSession = handle.resumedAs === 'sessão';
    const how = fromSession ? l10n.t('the agent session') : l10n.t('the conversation history');
    this.bus.publish<AgentStateEventData>('agent.state', id, {
      state: session.recovery ? 'pausado' : handle.state,
      previous: options.previousState ?? record.estado,
      reason: options.reason(fromSession),
    });
    this.scheduleSave(session);
    this.options.log?.(l10n.t('session {0} reopened with {1} in {2}', id, how, record.cwd));
    return session;
  }

  /**
   * Troca a conta do Claude das sessões abertas (ADR 0027). A ociosa reabre na
   * hora com a conta nova, mesma sessão e mesma conversa; a que está no meio de
   * uma vez troca quando a vez acabar; a encerrada e a guardada só mudam a conta
   * com que vão voltar. Devolve as sessões afetadas.
   */
  async switchClaudeAccount(slot: ClaudeAccountSlot | undefined): Promise<string[]> {
    const affected: string[] = [];
    const runs: Promise<unknown>[] = [];
    for (const session of [...this.sessions.values()]) {
      const { id } = session;
      if (!usesClaudeAccount(session.profile)) continue;
      if (this.switching.has(id) || this.reviving.has(id)) {
        // Já reabrindo: confere a conta de novo quando terminar.
        this.pendingSwitch.set(id, { slot });
        affected.push(id);
        continue;
      }
      if (session.account?.slot === slot) {
        this.pendingSwitch.delete(id);
        continue;
      }
      affected.push(id);
      const state = session.handle.state;
      if (session.recovery) {
        this.cancelRecoveryTimer(id);
        this.pendingSwitch.delete(id);
        runs.push(this.restart(session, slot).catch(() => undefined));
      } else if (isFinalAgentState(state)) {
        this.pendingSwitch.delete(id);
        runs.push(this.setEndedAccount(session, slot));
      } else if (IDLE.has(state)) {
        this.pendingSwitch.delete(id);
        runs.push(this.restart(session, slot).catch(() => undefined));
      } else {
        this.pendingSwitch.set(id, { slot });
        this.options.log?.(l10n.t('session {0} switches account when the turn ends', id));
      }
    }
    for (const record of [...this.dormant.values()]) {
      if (this.reviving.has(record.id)) {
        this.pendingSwitch.set(record.id, { slot });
        affected.push(record.id);
        continue;
      }
      const profile = this.profiles.find((candidate) => candidate.id === record.profileId);
      if (!profile || !usesClaudeAccount(profile) || record.contaClaude === slot) continue;
      affected.push(record.id);
      this.cancelRecoveryTimer(record.id);
      const version = this.recoveryVersions.get(record.id) ?? 0;
      runs.push(
        this.updateDormant(withAccount(record, slot)).then(async () => {
          if (
            this.recoveryOf(record.id) &&
            !this.closing &&
            version === (this.recoveryVersions.get(record.id) ?? 0)
          )
            await this.resume(record.id);
        }),
      );
    }
    await Promise.all(runs);
    return affected;
  }

  private accountName(slot: ClaudeAccountSlot | undefined): string {
    if (!slot) return l10n.t('default Claude Code account');
    return this.options.claudeAccounts?.ref(slot).apelido ?? l10n.t('Account {0}', slot);
  }

  /** Sessão encerrada: só a conta com que ela volta muda. */
  private async setEndedAccount(
    session: Session,
    slot: ClaudeAccountSlot | undefined,
  ): Promise<void> {
    session.account = slot ? this.options.claudeAccounts?.ref(slot) : undefined;
    await this.saveNow(session);
  }

  /** Faz a troca adiada de uma sessão, se a vez dela já acabou. */
  private applyPending(id: string): void {
    const pending = this.pendingSwitch.get(id);
    const session = this.sessions.get(id);
    if (!pending || !session || this.switching.has(id) || this.reviving.has(id)) return;
    const state = session.handle.state;
    if (isFinalAgentState(state) && !session.recovery) {
      this.pendingSwitch.delete(id);
      if (session.account?.slot !== pending.slot) void this.setEndedAccount(session, pending.slot);
      return;
    }
    if (!IDLE.has(state) && !session.recovery) return;
    this.pendingSwitch.delete(id);
    if (session.account?.slot === pending.slot) return;
    this.restart(session, pending.slot).catch(() => undefined);
  }

  /** Reabre a sessão ociosa com outra conta; enquanto isso, quem a procura espera. */
  private restart(session: Session, slot: ClaudeAccountSlot | undefined): Promise<Session> {
    const { id } = session;
    const previous = session.handle.state;
    // Começa depois do aviso abaixo, já com a sessão marcada como trocando.
    const run = Promise.resolve().then(() => this.reopenWithAccount(session, slot, previous));
    this.switching.set(id, run);
    this.bus.publish<AgentStateEventData>('agent.state', id, {
      state: 'preparando',
      previous,
      reason: l10n.t('switching to account {0}', this.accountName(slot)),
    });
    const clear = (): void => {
      this.switching.delete(id);
      this.applyPending(id);
    };
    run.then(clear, clear);
    return run;
  }

  private async reopenWithAccount(
    old: Session,
    slot: ClaudeAccountSlot | undefined,
    idleState: AgentState,
  ): Promise<Session> {
    const { id, profile, worktree } = old;
    // O snapshot guarda o prompt de sistema redigido; o agente novo precisa do original.
    const record = {
      ...withAccount(this.snapshot(old), slot),
      ...(old.systemPrompt ? { systemPrompt: old.systemPrompt } : {}),
    };
    // O agente antigo sai sem avisar o barramento: nada de "parado", de token
    // revogado nem de worktree guardado; a sessão e o trabalho continuam.
    old.replaced = true;
    clearTimeout(old.saveTimer);
    old.saveTimer = undefined;
    await old.handle.stop('usuário').catch(() => undefined);
    const stopped = this.stopRequests.get(id);
    if (stopped) {
      // Pediram para parar antes de o agente novo subir: a sessão encerra como numa parada normal.
      this.stopRequests.delete(id);
      this.endSwitch(old, stopped);
      return old;
    }
    const store = this.options.store;
    const entries =
      store && this.persisted(old) ? await store.transcript(id) : entriesOf(old.transcript);
    const name = this.accountName(slot);
    let session: Session;
    try {
      session = await this.reopen({
        id,
        record,
        profile,
        entries,
        worktree,
        slot,
        previous: old,
        // A sessão volta ao estado ocioso de antes: para o host e o orquestrador
        // isto não é fim de vez (sem aviso de "terminou", sem marcar resultado pronto).
        previousState: idleState,
        reason: () => l10n.t('account switched to {0}', name),
      });
    } catch (error) {
      // Não subiu com a conta nova: a sessão fica encerrada e retomável, com o trabalho guardado.
      const message = error instanceof Error ? error.message : String(error);
      this.stopRequests.delete(id);
      this.endSwitch(old, l10n.t('could not switch accounts: {0}', message));
      throw error;
    }
    this.options.log?.(l10n.t('session {0} switched to account {1}', id, name));
    // A parada pedida enquanto o agente novo subia vale para ele, pelo caminho normal.
    const late = this.stopRequests.get(id);
    if (late) {
      this.stopRequests.delete(id);
      await session.handle.stop(late).catch(() => undefined);
    } else if (session.recovery && !this.closing) {
      // Não passa por send() enquanto switching aponta para esta própria operação.
      this.clearRecovery(session);
      await session.handle.resume();
      if (!this.stopRequests.has(id) && !this.isClosing()) {
        const message = resumeAfterLimit();
        this.recordUser(session, message);
        this.bus.publish<AgentPromptEventData>('agent.prompt', id, { text: message });
        session.handle.send(message).catch(() => undefined);
      }
    }
    return session;
  }

  /** A troca não terminou com agente novo: a sessão antiga encerra de vez, com o worktree guardado. */
  private endSwitch(old: Session, reason: string): void {
    const { id, profile, worktree } = old;
    old.replaced = false;
    old.stopReason = reason;
    this.options.log?.(l10n.t('session {0} ended during the account switch: {1}', id, reason));
    this.bus.publish<AgentStateEventData>('agent.state', id, {
      state: old.handle.state,
      previous: 'preparando',
      reason,
    });
    if (worktree) old.released ??= this.release(id, profile, worktree);
    this.scheduleSave(old);
  }

  /** Apaga do disco uma sessão encerrada; as que ainda rodam ficam. */
  async forget(sessionId: string): Promise<null> {
    if (
      this.switching.has(sessionId) ||
      this.reviving.has(sessionId) ||
      this.resuming.has(sessionId)
    ) {
      throw RpcError.invalidParams(
        l10n.t('the session is switching accounts; try again in a moment'),
      );
    }
    const session = this.sessions.get(sessionId);
    // O orquestrador ainda usa o histórico, os custos e o branch das tarefas.
    if (session?.taskId || this.dormant.get(sessionId)?.taskId) return null;
    if (session && !isFinalAgentState(session.handle.state)) {
      throw RpcError.invalidParams(l10n.t('the session is still running; stop it first'));
    }
    if (!session && !this.dormant.has(sessionId)) {
      throw RpcError.notFound(l10n.t('session {0} does not exist', sessionId));
    }
    this.cancelRecoveryTimer(sessionId);
    await session?.released;
    if (session) clearTimeout(session.saveTimer);
    this.sessions.delete(sessionId);
    this.dormant.delete(sessionId);
    await this.options.store?.remove(sessionId);
    return null;
  }

  /** `closing` muda durante os awaits; a leitura por método não é estreitada pelo TS. */
  private isClosing(): boolean {
    return this.closing;
  }

  private async updateDormant(record: StoredSession): Promise<void> {
    const next = { ...record, atualizadoEm: new Date().toISOString() };
    this.dormant.set(next.id, next);
    await this.options.store?.save(next);
  }

  /** Troca uma opção de uma sessão sem agente: vale quando ela for retomada. */
  private async setDormantOption(
    record: StoredSession,
    id: string,
    value: string | boolean,
  ): Promise<void> {
    const option = record.opcoes.find((o) => o.id === id);
    if (
      !option ||
      typeof value !== typeof option.atual ||
      (option.valores && !option.valores.some((v) => v.id === value))
    ) {
      throw RpcError.invalidParams(l10n.t('option {0} is not valid for this session', id));
    }
    const opcoes = record.opcoes.map((o) => (o.id === id ? { ...o, atual: value } : o));
    await this.updateDormant({ ...record, opcoes });
    this.bus.publish<AgentOptionsEventData>('agent.options', record.id, { opcoes });
  }

  private publish(id: string, event: AgentEvent): void {
    switch (event.type) {
      case 'state': {
        const data: AgentStateEventData = {
          state: event.state,
          previous: event.previous,
          ...(event.reason ? { reason: event.reason } : {}),
        };
        this.bus.publish('agent.state', id, data);
        break;
      }
      case 'output':
        this.bus.publish<AgentOutputEventData>('agent.output', id, {
          kind: event.kind,
          text: this.options.redact?.(event.text) ?? event.text,
        });
        break;
      case 'error':
        this.bus.publish<AgentOutputEventData>('agent.output', id, {
          kind: 'error',
          text: this.options.redact?.(event.message) ?? event.message,
        });
        break;
      case 'tool': {
        const data: AgentToolEventData = {
          toolCallId: event.toolCallId,
          ...(event.title ? { title: event.title } : {}),
          ...(event.kind ? { kind: event.kind } : {}),
          ...(event.status ? { status: event.status } : {}),
        };
        this.bus.publish('agent.tool', id, data);
        break;
      }
      case 'permission':
        this.bus.publish<AgentPermissionEventData>('agent.permission', id, {
          id: event.id,
          title: event.title,
          ...(event.detail ? { detail: event.detail } : {}),
          options: event.options,
        });
        break;
      case 'file':
        this.bus.publish('agent.file', id, { path: event.path });
        break;
      case 'usage':
        this.bus.publish('cost.update', id, event.usage);
        break;
      case 'options':
        this.bus.publish<AgentOptionsEventData>('agent.options', id, { opcoes: event.options });
        break;
    }
  }
}
