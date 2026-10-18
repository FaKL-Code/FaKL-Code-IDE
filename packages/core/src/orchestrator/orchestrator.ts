import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { commitWorktree, type AgentProfile, type McpServerRef } from '@fakl/agents';
import { l10n } from '@fakl/i18n';
import {
  DEFAULT_DELIVERY,
  DELIVERIES,
  FaklErrorCode,
  isFinalAgentState,
  isPermissionMode,
  PERMISSION_MODES,
  type AgentOutputEventData,
  type AgentRecoveryInfo,
  type AgentState,
  type AgentStateEventData,
  type CheckResult,
  type DailyCapEventData,
  type Decision,
  type DecisionOption,
  type Delivery,
  type PostMergeBuild,
  type DoneCriteria,
  type FaklEvent,
  type LimitName,
  type PermissionPolicyName,
  type ResourceContent,
  type ResourceKind,
  type Round,
  type Run,
  type RunAgent,
  type RunLimitEventData,
  type RunLimits,
  type RunStatus,
  type ScorecardSummary,
  type Task,
  type TaskDefinition,
  type TaskStatus,
} from '@fakl/protocol';

import type { AgentRuntime } from '../agents.js';
import type { CostTracker } from '../costs.js';
import type { Disposable, EventBus } from '../events/bus.js';
import { git, run as exec, runShell } from '../exec.js';
import { scanSecrets } from '../security/scan.js';
import {
  objectParams,
  RpcError,
  stringArrayParam,
  stringParam,
  type Router,
} from '../rpc/router.js';
import type { ToolSetName } from '../mcp/tools.js';
import { readJson, writeJsonAtomic } from '../store.js';
import { ulid } from '../ulid.js';
import { effectiveLimits, exceeded, parseLimits, scaleLimits } from './limits.js';
import { maestroPrompt, resourcesBriefing, workerPrompt, type ResourceSummary } from './prompts.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const WORKING: ReadonlySet<AgentState> = new Set<AgentState>([
  'preparando',
  'pensando',
  'executando',
  'aguardando-permissão',
]);
const ACTIVE_RUN: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'executando',
  'pausada',
  'aguardando-decisão',
]);
const MERGE_ATTEMPTS = 3;
const MERGE_RETRY_MS = 3_000;
const CHECK_TIMEOUT_MS = 20 * 60_000;
const CHECK_TAIL = 4_000;
const REPLY_LIMIT = 6_000;
const DIFF_LIMIT = 120_000;
const MAX_NUDGES = 2;
const LIMIT_TICK_MS = 30_000;
export interface OrchestratorOptions {
  readonly bus: EventBus;
  readonly agents: AgentRuntime;
  readonly costs: CostTracker;
  /** Placar por perfil, para o `list_profiles` do maestro (ADR 0043); sem ele, a lista não traz o placar. */
  readonly scorecard?: { summaryFor(profileId: string): ScorecardSummary };
  readonly profiles: () => readonly AgentProfile[];
  /** Limites, entrega e build pós-merge padrão da configuração global. */
  readonly defaults?: () => {
    limites?: RunLimits;
    entrega?: Delivery;
    buildAposMerge?: PostMergeBuild;
  };
  /** Onde ficam `tasks/` e `runs/`; sem ela, tudo fica na memória. */
  readonly dataDir?: string;
  /** Servidor MCP `fakl` de uma sessão, com um token só dela; sem ele, não há maestro. */
  readonly mcpFor?: (
    sessionId: string,
    tools: readonly ToolSetName[],
    profile: AgentProfile,
  ) => McpServerRef[];
  /** Entrega pelo GitHub do Core: token no push e PR pela API (SDD 11.1). */
  readonly github?: {
    gitEnv(): Record<string, string>;
    readonly connected: boolean;
    createPull(
      repoRoot: string,
      pull: { title: string; head: string; base: string; body: string; draft: boolean },
    ): Promise<{ html_url: string; number?: number }>;
    mergePull?(
      repoRoot: string,
      number: number,
      title: string,
    ): Promise<{ merged: boolean; message: string }>;
    dispatchWorkflow?(
      repoRoot: string,
      workflow: string,
      ref: string,
      inputs: Readonly<Record<string, string>>,
    ): Promise<{ html_url: string }>;
  };
  /** Projeto Lovable do repositório, que recebe push do branch acompanhado (SDD 11.4). */
  readonly lovable?: (repoRoot: string) => Promise<{ url: string; branch: string } | undefined>;
  /** Contexto extra do maestro, como as integrações disponíveis e o Lovable. */
  readonly maestroContext?: (repoRoot: string) => Promise<readonly string[]>;
  /** Agentes e skills instalados na IDE, listados no prompt do maestro. */
  readonly resources?: () => ResourceSummary | undefined;
  /** Conteúdo de um agente ou skill (instalado ou do catálogo), injetado no subagente. */
  readonly resource?: (kind: ResourceKind, name: string) => Promise<ResourceContent>;
  /** Segredos conhecidos, para a varredura antes do push (SDD 14.1). */
  readonly knownSecrets?: () => readonly string[];
  readonly log?: (message: string) => void;
  readonly clock?: () => Date;
}

interface RunState {
  run: Omit<Mutable<Run>, 'agentes' | 'rodadas' | 'decisoes'> & {
    agentes: RunAgent[];
    rodadas: Round[];
    decisoes: Mutable<Decision>[];
  };
  task: Task;
  repoRoot: string;
  base: string;
  limits: RunLimits;
  startedAt: number;
  timer?: NodeJS.Timeout;
  /** Texto da vez atual de cada sessão e a última resposta completa. */
  readonly current: Map<string, string>;
  readonly lastReply: Map<string, string>;
  /** Sessões cuja vez terminou desde a última mensagem. */
  readonly turnDone: Set<string>;
  readonly waiters: Map<string, (choice: string) => void>;
  nudges: number;
  finishing: boolean;
  limitPending: boolean;
  pausedForLimit: string[];
  /** Estado do worktree na última rodada, para `finish` não repetir uma rodada que já passou. */
  lastRoundTree?: string | undefined;
  saving?: Promise<void> | undefined;
}

/**
 * Impressão do worktree: commit, mudanças rastreadas e arquivos novos. Igual
 * entre duas rodadas, o critério não tem por que rodar de novo.
 */
async function treeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const hash = createHash('sha1');
    hash.update(await git(['rev-parse', 'HEAD'], cwd));
    hash.update(await git(['diff', 'HEAD', '--binary'], cwd));
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
    for (const file of untracked.split('\0').filter(Boolean).sort()) {
      hash.update(file);
      hash.update(await readFile(join(cwd, file)).catch(() => Buffer.alloc(0)));
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

function now(clock: () => Date): string {
  return clock().toISOString();
}

function truncate(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n${l10n.t('[... {0} characters truncated]', String(text.length - max))}`
    : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw RpcError.invalidParams(l10n.t('{0} must be a list of strings', name));
  }
  return value;
}

/** Valida uma tarefa vinda da API, da CLI ou do controle remoto. */
export function parseTaskDefinition(raw: unknown): TaskDefinition {
  if (!isObject(raw)) throw RpcError.invalidParams(l10n.t('the task must be an object'));
  const titulo = typeof raw.titulo === 'string' ? raw.titulo.trim() : '';
  if (!titulo) throw RpcError.invalidParams(l10n.t('the task needs a title'));
  const repoPath = typeof raw.repoPath === 'string' ? raw.repoPath : '';
  if (!isAbsolute(repoPath)) {
    throw RpcError.invalidParams(l10n.t('repoPath must be an absolute path'));
  }
  const entrega = raw.entrega as Delivery | undefined;
  if (entrega !== undefined && !DELIVERIES.includes(entrega)) {
    throw RpcError.invalidParams(l10n.t('entrega must be {0}', DELIVERIES.join(', ')));
  }
  let criterio: DoneCriteria | undefined;
  if (raw.criterio !== undefined && raw.criterio !== null) {
    if (!isObject(raw.criterio)) {
      throw RpcError.invalidParams(l10n.t('criterio must be an object'));
    }
    const comandos = strings(raw.criterio.comandos, 'criterio.comandos');
    const checklist = strings(raw.criterio.checklist, 'criterio.checklist');
    const revisao = raw.criterio.revisao;
    criterio = {
      ...(comandos ? { comandos } : {}),
      ...(checklist ? { checklist } : {}),
      ...(isObject(revisao)
        ? {
            revisao: {
              ...(typeof revisao.perfil === 'string' ? { perfil: revisao.perfil } : {}),
              ...(typeof revisao.exigeAprovacao === 'boolean'
                ? { exigeAprovacao: revisao.exigeAprovacao }
                : {}),
            },
          }
        : {}),
    };
  }
  let limites: RunLimits | undefined;
  try {
    limites = parseLimits(raw.limites, 'limites');
  } catch (error) {
    throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
  }
  const papeis = raw.papeisFixados;
  if (
    papeis !== undefined &&
    (!isObject(papeis) || !Object.values(papeis).every((v) => typeof v === 'string'))
  ) {
    throw RpcError.invalidParams(l10n.t('papeisFixados must map roles to profile ids'));
  }
  const permissoes = raw.permissoes;
  if (permissoes !== undefined && !isPermissionMode(permissoes)) {
    throw RpcError.invalidParams(l10n.t('permissoes must be {0}', PERMISSION_MODES.join(', ')));
  }
  const text = (name: string): string | undefined =>
    typeof raw[name] === 'string' && raw[name] ? raw[name] : undefined;
  const origem = text('origem');
  const descricao = text('descricao');
  const branchBase = text('branchBase');
  const maestroProfileId = text('maestroProfileId');
  const permitidos = strings(raw.perfisPermitidos, 'perfisPermitidos');
  // Um papel fixado pelo usuário vale mais que a lista: o perfil dele sempre pode ser chamado.
  const perfisPermitidos = permitidos && [
    ...new Set([...permitidos, ...Object.values((papeis ?? {}) as Record<string, string>)]),
  ];
  const playbook = text('playbook');
  const referencia = text('referencia');
  return {
    titulo,
    repoPath,
    ...(descricao ? { descricao } : {}),
    ...(origem ? { origem: origem as TaskDefinition['origem'] & string } : {}),
    ...(branchBase ? { branchBase } : {}),
    ...(criterio ? { criterio } : {}),
    ...(limites ? { limites } : {}),
    ...(perfisPermitidos ? { perfisPermitidos } : {}),
    ...(maestroProfileId ? { maestroProfileId } : {}),
    ...(papeis ? { papeisFixados: papeis as Record<string, string> } : {}),
    ...(playbook ? { playbook } : {}),
    ...(entrega ? { entrega } : {}),
    ...(permissoes ? { permissoes } : {}),
    ...(referencia ? { referencia } : {}),
  };
}

/**
 * Orquestrador (SDD 9): tarefas, execuções, rodadas, critério de pronto,
 * limites e entrega. O maestro é um agente comum que recebe o servidor MCP
 * `fakl`; cada ferramenta dele vira um método `maestro.*` chamado com o token
 * da sessão, e é aqui que profundidade, papéis fixados e limites são
 * aplicados antes de executar.
 */
/**
 * Apaga o branch de um agente. Um worktree que sobrou (o agente caiu antes de
 * guardar) ou uma trava do git de outra operação no mesmo repositório fariam o
 * `branch -D` falhar; então tira o worktree e tenta de novo.
 */
async function deleteBranch(
  repo: string,
  branch: string,
  log?: (message: string) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const list = await git(['worktree', 'list', '--porcelain'], repo).catch(() => '');
    for (const block of list.split(/\n\n+/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (path && block.includes(`branch refs/heads/${branch}`)) {
        await git(['worktree', 'remove', '--force', path], repo).catch(() => '');
      }
    }
    const exists = await git(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], repo).then(
      () => true,
      () => false,
    );
    if (!exists) return;
    const deleted = await git(['branch', '-D', branch], repo).then(
      () => true,
      () => false,
    );
    if (deleted) return;
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  log?.(l10n.t('could not delete branch {0}', branch));
}

/** Cabeçalho Conventional Commits (`feat(core): ...`, `fix!: ...`). */
const CONVENTIONAL =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([\w.-]+\))?!?: \S/;

/**
 * Título do PR e do squash de uma entrega. O título da tarefa é a frase do
 * usuário e quase nunca segue Conventional Commits; os commits dos agentes,
 * sim. Usa o título da tarefa se já estiver no padrão, senão o primeiro commit
 * convencional do branch (os pontos de salvamento `fakl: ...` não contam), e
 * por último `chore: <título>`.
 */
export function deliveryTitle(titulo: string, subjects: readonly string[]): string {
  const task = titulo.trim();
  if (CONVENTIONAL.test(task)) return task;
  const commit = subjects.map((s) => s.trim()).find((s) => CONVENTIONAL.test(s));
  return commit ?? `chore: ${task}`;
}

/** Orquestração sem nenhum provedor de IA configurado. */
export function noProviderMessage(): string {
  return l10n.t(
    'the maestro needs an AI provider and none is configured: log in to Claude, Codex or Gemini through the CLI, store an API key ("FaKL: Definir chave de API"), turn on a local model (Ollama or LM Studio) or register an ACP agent ("FaKL: Cadastrar agente ACP")',
  );
}

/**
 * Perfil para o sugerido por um recurso: ele mesmo, se existe; senão um da
 * mesma família de id (`claude-sonnet` ↔ `claude`); senão o de quem delega;
 * senão o primeiro permitido.
 */
export function fallbackProfile(
  suggested: readonly string[],
  allowed: readonly string[],
  callerProfileId?: string,
): string | undefined {
  const exact = suggested.find((id) => allowed.includes(id));
  if (exact) return exact;
  for (const id of suggested) {
    const family = id.split('-')[0] ?? id;
    const relative = allowed.find(
      (candidate) => candidate === family || candidate.startsWith(`${family}-`),
    );
    if (relative) return relative;
  }
  if (callerProfileId && allowed.includes(callerProfileId)) return callerProfileId;
  return allowed[0];
}

export class Orchestrator implements Disposable {
  private readonly tasks = new Map<string, Task>();
  private readonly runs = new Map<string, RunState>();
  /** Execuções ativas quando o Core anterior parou, na ordem em que foram lidas. */
  private readonly interrupted: string[] = [];
  private readonly finishing = new Set<Promise<void>>();
  private readonly bySession = new Map<string, RunState>();
  /** Sessões do chat virando maestro; duas chamadas ao mesmo tempo abrem uma execução só. */
  private readonly adopting = new Map<string, Promise<void>>();
  private readonly resuming = new Map<string, Promise<null>>();
  private readonly listeners = new Set<() => void>();
  private readonly subscription: Disposable;
  private readonly clock: () => Date;

  constructor(private readonly options: OrchestratorOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.subscription = options.bus.subscribe(
      ['agent.state', 'agent.output', 'agent.recovery', 'cost.update', 'run.limit'],
      (event) => {
        this.onEvent(event);
      },
    );
  }

  dispose(): void {
    this.subscription.dispose();
    for (const state of this.runs.values()) clearInterval(state.timer);
  }

  // ---------------------------------------------------------------- persistência

  private taskFile(id: string): string | undefined {
    return this.options.dataDir ? join(this.options.dataDir, 'tasks', `${id}.json`) : undefined;
  }

  private runFile(id: string): string | undefined {
    return this.options.dataDir ? join(this.options.dataDir, 'runs', `${id}.json`) : undefined;
  }

  /**
   * Lê tarefas e execuções. Execuções que estavam ativas quando a IDE fechou
   * voltam como pausadas, sem agentes; `runs.resume` as retoma com um maestro
   * novo e o histórico das rodadas (SDD 6.1).
   */
  async load(): Promise<void> {
    const dir = this.options.dataDir;
    if (!dir) return;
    for (const name of await readdir(join(dir, 'tasks')).catch(() => [])) {
      const task = await readJson<Task>(join(dir, 'tasks', name));
      if (task?.id) this.tasks.set(task.id, task);
    }
    for (const name of await readdir(join(dir, 'runs')).catch(() => [])) {
      const run = await readJson<RunState['run']>(join(dir, 'runs', name));
      const task = run ? this.tasks.get(run.taskId) : undefined;
      if (!run?.id || !task) continue;
      const state = this.newState(run, task, '', '');
      if (ACTIVE_RUN.has(run.status) && task.origem === 'chat' && !run.retomada) {
        // A conversa não volta com a IDE: a execução implícita dela termina aqui.
        state.run.status = 'concluída';
        state.run.resultado = 'branch';
        state.run.motivo = l10n.t('the IDE closed during the conversation');
        state.run.fim ??= now(this.clock);
        for (const decision of state.run.decisoes) decision.escolha ??= 'cancelada';
        await this.saveRun(state);
        if (task.status === 'executando') await this.saveTask({ ...task, status: 'concluída' });
      } else if (ACTIVE_RUN.has(run.status)) {
        state.run.status = 'pausada';
        state.run.motivo = run.retomada?.mensagem ?? l10n.t('the IDE closed during the run');
        this.interrupted.push(run.id);
        for (const decision of state.run.decisoes) {
          decision.escolha ??= 'cancelada';
        }
        await this.saveRun(state);
      }
      this.runs.set(run.id, state);
      for (const agent of run.agentes) this.bySession.set(agent.sessionId, state);
    }
  }

  /**
   * Retoma as execuções que estavam ativas quando o Core anterior caiu
   * (RNF-06). Uma que não volte fica pausada, com o motivo, para o usuário.
   */
  async resumeInterrupted(): Promise<string[]> {
    const resumed: string[] = [];
    for (const id of this.interrupted.splice(0)) {
      const state = this.runs.get(id);
      if (state?.run.status !== 'pausada' || state.run.retomada) continue;
      try {
        await this.resumeRun(state);
        resumed.push(id);
      } catch (error) {
        state.run.status = 'pausada';
        state.run.motivo = l10n.t(
          'the Core restarted and could not resume: {0}',
          error instanceof Error ? error.message : String(error),
        );
        await this.saveRun(state);
        this.options.log?.(l10n.t('run {0} was not resumed: {1}', id, state.run.motivo));
      }
    }
    return resumed;
  }

  private async saveTask(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
    const file = this.taskFile(task.id);
    if (file) await writeJsonAtomic(file, task);
    this.changed();
  }

  private async saveRun(state: RunState): Promise<void> {
    const file = this.runFile(state.run.id);
    if (file) {
      const snapshot = structuredClone(state.run);
      const saving = (state.saving ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => writeJsonAtomic(file, snapshot));
      state.saving = saving;
      await saving;
    }
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Espera uma condição reavaliada a cada mudança; `false` se o prazo acabar. */
  private until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = (): void => {
        if (predicate()) finish(true);
      };
      const timer = setTimeout(() => {
        finish(false);
      }, timeoutMs);
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(value);
      };
      this.listeners.add(check);
    });
  }

  // ---------------------------------------------------------------- API

  register(router: Router): void {
    router.register('tasks.create', (params) => this.createTask(objectParams(params)));
    router.register('tasks.list', () => [...this.tasks.values()]);
    router.register('tasks.get', (params) => {
      const task = this.task(stringParam(objectParams(params), 'taskId'));
      return { task, runs: task.runs.flatMap((id) => this.runs.get(id)?.run ?? []) };
    });
    router.register('tasks.cancel', async (params) => {
      const task = this.task(stringParam(objectParams(params), 'taskId'));
      for (const id of task.runs) {
        const state = this.runs.get(id);
        if (state && ACTIVE_RUN.has(state.run.status))
          await this.discard(state, l10n.t('task canceled'), false);
      }
      await this.saveTask({ ...task, status: 'cancelada' });
      return null;
    });

    router.register('runs.start', (params) =>
      this.startRun(stringParam(objectParams(params), 'taskId')),
    );
    router.register('runs.get', (params) => this.state(objectParams(params)).run);
    router.register('runs.tree', (params) => {
      const state = this.state(objectParams(params));
      return state.run.agentes.map((agent) => ({
        ...agent,
        state: this.options.agents.stateOf(agent.sessionId) ?? 'parado',
      }));
    });
    router.register('runs.pause', async (params) => {
      const state = this.state(objectParams(params));
      await Promise.all(
        state.run.agentes.map(async (a) => {
          if (this.options.agents.recoveryOf(a.sessionId)) {
            await this.options.agents.setAutoResume(a.sessionId, false);
          }
          await this.options.agents.pause(a.sessionId);
        }),
      );
      if (state.run.status === 'executando') state.run.status = 'pausada';
      await this.saveRun(state);
      return null;
    });
    router.register('runs.resume', async (params) =>
      this.resumeRun(this.state(objectParams(params))),
    );
    router.register('runs.setAutoResume', async (params) => {
      const p = objectParams(params);
      if (typeof p.automatica !== 'boolean')
        throw RpcError.invalidParams(l10n.t('automatica must be true or false'));
      const state = this.state(p);
      if (!ACTIVE_RUN.has(state.run.status) || !state.run.retomada) {
        throw new RpcError(
          FaklErrorCode.Conflict,
          l10n.t('the run is not waiting for the session limit'),
        );
      }
      await this.options.agents.setAutoResume(state.run.retomada.sessionId, p.automatica);
      return null;
    });
    router.register('runs.stop', async (params) => {
      const state = this.state(objectParams(params));
      await this.finalize(state, 'falha', l10n.t('stopped by the user'), 'branch');
      return null;
    });
    router.register('runs.decide', async (params) => {
      const p = objectParams(params);
      const state = this.state(p);
      const decisionId = stringParam(p, 'decisionId');
      const escolha = stringParam(p, 'escolha');
      const decision = state.run.decisoes.find((d) => d.id === decisionId);
      if (!decision) throw RpcError.notFound(l10n.t('decision {0} does not exist', decisionId));
      if (decision.escolha !== undefined) {
        throw new RpcError(
          FaklErrorCode.Conflict,
          l10n.t('this decision has already been answered'),
        );
      }
      if (!decision.opcoes.some((o) => o.id === escolha)) {
        throw RpcError.invalidParams(
          l10n.t('escolha must be {0}', decision.opcoes.map((o) => o.id).join(', ')),
        );
      }
      decision.escolha = escolha;
      decision.respondidaEm = now(this.clock);
      const origem = p.origem;
      decision.origemResposta = origem === 'remoto' || origem === 'cli' ? origem : 'ide';
      await this.saveRun(state);
      state.waiters.get(decisionId)?.(escolha);
      state.waiters.delete(decisionId);
      return null;
    });
    router.register('runs.decisions', () =>
      [...this.runs.values()].flatMap((state) =>
        state.run.decisoes.filter((d) => d.escolha === undefined),
      ),
    );

    router.register('maestro.listProfiles', async (_params, context) =>
      this.listProfiles(await this.caller(context.principal)),
    );
    router.register('maestro.spawnAgent', async (params, context) =>
      this.spawnAgent(await this.caller(context.principal), objectParams(params)),
    );
    router.register('maestro.sendMessage', async (params, context) => {
      const caller = await this.caller(context.principal);
      const p = objectParams(params);
      const child = this.child(caller, stringParam(p, 'sessionId'), true);
      this.sendTo(caller.state, child.sessionId, stringParam(p, 'texto'));
      return { ok: true };
    });
    router.register('maestro.awaitResults', async (params, context) =>
      this.awaitResults(await this.caller(context.principal), objectParams(params)),
    );
    router.register('maestro.reviewDiff', async (params, context) => {
      const caller = await this.caller(context.principal);
      return this.reviewDiff(caller, stringParam(objectParams(params), 'sessionId'));
    });
    router.register('maestro.runChecks', async (params, context) => {
      const caller = await this.caller(context.principal);
      const p = params === undefined ? {} : objectParams(params);
      return this.runChecks(caller, strings(p.verificacoes, 'verificacoes'));
    });
    router.register('maestro.mergeWork', async (params, context) =>
      this.mergeWork(
        await this.caller(context.principal),
        stringArrayParam(objectParams(params), 'sessionIds'),
      ),
    );
    router.register('maestro.stopAgent', async (params, context) => {
      const caller = await this.caller(context.principal);
      const child = this.child(caller, stringParam(objectParams(params), 'sessionId'), false);
      await this.options.agents.stop(child.sessionId, 'maestro');
      return { ok: true };
    });
    router.register('maestro.askHuman', async (params, context) => {
      const caller = await this.caller(context.principal);
      const p = objectParams(params);
      const opcoes = stringArrayParam(p, 'opcoes');
      if (opcoes.length < 2) throw RpcError.invalidParams(l10n.t('give at least two options'));
      const options = opcoes.map((rotulo, index) => ({ id: String(index + 1), rotulo }));
      const choice = await this.ask(caller.state, stringParam(p, 'pergunta'), options, {
        sessionId: caller.sessionId,
        autopilot: '1',
      });
      return {
        escolha: options.find((o) => o.id === choice)?.rotulo ?? choice,
        ...(this.mode(caller.state) === 'autopilot'
          ? { autopilot: l10n.t('nobody answered: in autopilot the first option applies') }
          : {}),
      };
    });
    router.register('maestro.finish', async (params, context) =>
      this.finishFromMaestro(await this.caller(context.principal), objectParams(params)),
    );
  }

  private task(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw RpcError.notFound(l10n.t('task {0} does not exist', id));
    return task;
  }

  private state(p: Record<string, unknown>): RunState {
    const id = stringParam(p, 'runId');
    const state = this.runs.get(id);
    if (!state) throw RpcError.notFound(l10n.t('run {0} does not exist', id));
    return state;
  }

  private async caller(principal: string | undefined): Promise<{
    state: RunState;
    agent: RunAgent;
    sessionId: string;
  }> {
    if (principal && this.needsAdoption(principal)) await this.adopt(principal);
    const state = principal ? this.bySession.get(principal) : undefined;
    const agent = state?.run.agentes.find((a) => a.sessionId === principal);
    if (!state || !agent || !principal || agent.papel !== 'maestro') {
      throw new RpcError(
        FaklErrorCode.Forbidden,
        l10n.t('only the maestro of a run uses these tools'),
      );
    }
    if (!ACTIVE_RUN.has(state.run.status)) {
      throw new RpcError(FaklErrorCode.Conflict, l10n.t('the run is {0}', state.run.status));
    }
    // Uma ferramenta chamada é sinal de progresso: zera os lembretes.
    state.nudges = 0;
    return { state, agent, sessionId: principal };
  }

  /**
   * Sessão do chat que chama outros agentes (Maestro Mode): vira o maestro de
   * uma execução implícita, sem limites nem entrega, para que spawn_agent,
   * await_results e merge_work valham para ela e a Mesa desenhe os cabos.
   */
  /**
   * Sem execução, ou com a execução implícita de uma conversa que terminou e
   * foi retomada depois (mesma sessão): abre uma execução nova.
   */
  private needsAdoption(sessionId: string): boolean {
    const state = this.bySession.get(sessionId);
    if (!state) return true;
    return (
      state.task.origem === 'chat' &&
      state.run.maestroSessionId === sessionId &&
      !ACTIVE_RUN.has(state.run.status)
    );
  }

  private adopt(sessionId: string): Promise<void> {
    let pending = this.adopting.get(sessionId);
    if (!pending) {
      pending = this.adoptChat(sessionId).finally(() => this.adopting.delete(sessionId));
      this.adopting.set(sessionId, pending);
    }
    return pending;
  }

  private async adoptChat(sessionId: string): Promise<void> {
    const info = this.options.agents.sessionProfile(sessionId);
    const cwd = this.options.agents.cwdOf(sessionId);
    const alive = this.options.agents.stateOf(sessionId);
    // Sessões de tarefa já estão numa execução; o resto cai no "só o maestro" do caller.
    if (!info || !cwd || info.taskId || alive === undefined || isFinalAgentState(alive)) return;
    const tree = this.options.agents.worktree(sessionId);
    let repoRoot: string;
    let base: string;
    try {
      repoRoot = tree?.repoRoot ?? (await git(['rev-parse', '--show-toplevel'], cwd));
      base = tree?.branch ?? (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot));
      await git(['rev-parse', '--verify', `${base}^{commit}`], repoRoot);
    } catch {
      throw RpcError.invalidParams(
        l10n.t(
          '{0} must be a git repository with at least one commit to call other agents: each subagent works in its own worktree. Run "git init" and make a commit.',
          cwd,
        ),
      );
    }
    if (!this.needsAdoption(sessionId)) return;
    const runId = ulid();
    const task: Task = {
      id: ulid(),
      titulo: l10n.t('Chat with {0}', info.profile.nome),
      repoPath: repoRoot,
      origem: 'chat',
      entrega: 'branch',
      status: 'executando',
      criadaEm: now(this.clock),
      runs: [runId],
    };
    const run: RunState['run'] = {
      id: runId,
      taskId: task.id,
      status: 'executando',
      inicio: task.criadaEm,
      branch: tree?.branch ?? '',
      maestroSessionId: sessionId,
      agentes: [
        {
          sessionId,
          profileId: info.profile.id,
          papel: 'maestro',
          profundidade: 0,
          ...(tree ? { branch: tree.branch } : {}),
        },
      ],
      rodadas: [],
      decisoes: [],
    };
    const state = this.newState(run, task, repoRoot, base);
    // A conversa é do usuário: nada de prazo, orçamento ou rodadas; só a profundidade vale.
    const depth = state.limits.profundidadeMaxima;
    state.limits = depth === undefined ? {} : { profundidadeMaxima: depth };
    this.runs.set(runId, state);
    this.bySession.set(sessionId, state);
    await this.saveTask(task);
    await this.saveRun(state);
    this.publishAgents(state);
    this.options.log?.(
      l10n.t('chat session {0} started coordinating agents (run {1})', sessionId, runId),
    );
  }

  /** Quem está na execução mudou: a Mesa redesenha os cabos maestro → subagentes na hora. */
  private publishAgents(state: RunState): void {
    this.options.bus.publish('run.agents', state.run.id, {
      runId: state.run.id,
      agentes: state.run.agentes,
    });
  }

  /** Subagente desta execução; `direct` exige filho direto, senão vale qualquer descendente. */
  private child(
    caller: { state: RunState; sessionId: string },
    sessionId: string,
    direct: boolean,
  ): RunAgent {
    const agent = caller.state.run.agentes.find((a) => a.sessionId === sessionId);
    let ancestor = agent?.parentSessionId;
    let ok = ancestor === caller.sessionId;
    while (!ok && !direct && ancestor) {
      const parent = caller.state.run.agentes.find((a) => a.sessionId === ancestor);
      ancestor = parent?.parentSessionId;
      ok = ancestor === caller.sessionId;
    }
    if (!agent || !ok) {
      throw RpcError.invalidParams(
        direct
          ? l10n.t('session {0} is not your direct child', sessionId)
          : l10n.t('session {0} is not your descendant', sessionId),
      );
    }
    return agent;
  }

  // ---------------------------------------------------------------- tarefas e execuções

  /** Tarefa pelo id, ou nada. */
  taskById(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** Todas as execuções conhecidas (o café conta as do dia). */
  runList(): readonly Run[] {
    return [...this.runs.values()].map((state) => state.run);
  }

  /** Papel de uma sessão numa execução: maestro, executor, revisor, e quem a criou. */
  agentInRun(sessionId: string): (RunAgent & { runId: string }) | undefined {
    for (const state of this.runs.values()) {
      const agent = state.run.agentes.find((a) => a.sessionId === sessionId);
      if (agent) return { ...agent, runId: state.run.id };
    }
    return undefined;
  }

  async createTask(raw: unknown): Promise<Task> {
    const definition = parseTaskDefinition(raw);
    const task: Task = {
      ...definition,
      id: ulid(),
      origem: definition.origem ?? 'manual',
      status: 'nova',
      criadaEm: now(this.clock),
      runs: [],
    };
    await this.saveTask(task);
    return task;
  }

  private newState(run: RunState['run'], task: Task, repoRoot: string, base: string): RunState {
    const defaults = this.options.defaults?.() ?? {};
    return {
      run,
      task,
      repoRoot,
      base,
      limits: effectiveLimits(task.limites, defaults.limites),
      startedAt: Date.parse(run.inicio) + (run.esperaLimiteMs ?? 0),
      current: new Map(),
      lastReply: new Map(),
      turnDone: new Set(),
      waiters: new Map(),
      nudges: 0,
      finishing: false,
      limitPending: false,
      pausedForLimit: [],
    };
  }

  async startRun(taskId: string): Promise<Run> {
    const task = this.task(taskId);
    const running = task.runs.some((id) => {
      const status = this.runs.get(id)?.run.status;
      return status !== undefined && ACTIVE_RUN.has(status);
    });
    if (running)
      throw new RpcError(FaklErrorCode.Conflict, l10n.t('this task already has an active run'));
    if (!this.options.mcpFor) {
      throw RpcError.invalidParams(
        l10n.t('the fakl MCP server is not available in this installation'),
      );
    }
    let repoRoot: string;
    let base: string;
    try {
      repoRoot = await git(['rev-parse', '--show-toplevel'], task.repoPath);
      base = task.branchBase ?? (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot));
      await git(['rev-parse', '--verify', `${base}^{commit}`], repoRoot);
    } catch (error) {
      throw RpcError.invalidParams(
        l10n.t(
          '{0} must be a git repository with at least one commit (the maestro and each subagent work in worktrees); run "git init" and make a commit, or open the right folder. Detail: {1}',
          task.repoPath,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    const maestroId = task.maestroProfileId ?? (await this.defaultMaestro());
    const run: RunState['run'] = {
      id: ulid(),
      taskId,
      status: 'executando',
      inicio: now(this.clock),
      branch: '',
      agentes: [],
      rodadas: [],
      decisoes: [],
    };
    const state = this.newState(run, task, repoRoot, base);
    this.runs.set(run.id, state);
    try {
      await this.startMaestro(state, maestroId, base);
    } catch (error) {
      this.runs.delete(run.id);
      throw error;
    }
    const updated: Task = { ...task, status: 'executando', runs: [...task.runs, run.id] };
    state.task = updated;
    await this.saveTask(updated);
    this.startTimer(state);
    await this.saveRun(state);
    return run;
  }

  /**
   * Maestro padrão: um perfil instalado que pode ser maestro, de preferência
   * um agente de CLI (modelo local fica por último). Sem provedor nenhum, a
   * orquestração fica indisponível e a mensagem diz como ligar um.
   */
  private async defaultMaestro(): Promise<string> {
    const profiles = this.options.profiles();
    if (profiles.length === 0) throw RpcError.invalidParams(noProviderMessage());
    const missing = new Set(
      (await this.options.agents.detect().catch(() => []))
        .filter((item) => item.availability.status === 'não-instalado')
        .map((item) => item.id),
    );
    const ready = profiles.filter((profile) => !missing.has(profile.id));
    if (ready.length === 0) {
      throw RpcError.invalidParams(
        l10n.t(
          'none of the configured profiles ({0}) has the agent installed or the local server running; see AI Providers in the IDE',
          profiles.map((p) => p.id).join(', '),
        ),
      );
    }
    const remote = ready.filter((profile) => profile.adaptador !== 'ollama');
    const maestro =
      remote.find((profile) => profile.podeSerMaestro) ??
      ready.find((profile) => profile.podeSerMaestro) ??
      remote[0] ??
      ready[0];
    if (!maestro) throw RpcError.invalidParams(noProviderMessage());
    return maestro.id;
  }

  private resourcesContext(): { resources?: ResourceSummary } {
    const resources = this.options.resources?.();
    return resources ? { resources } : {};
  }

  /** Ferramentas de uma sessão da tarefa que voltou do diário do runtime. */
  sessionMcp(sessionId: string, profile: AgentProfile): McpServerRef[] | undefined {
    const state = this.bySession.get(sessionId);
    const agent = state?.run.agentes.find((item) => item.sessionId === sessionId);
    if (!agent) return undefined;
    return agent.papel === 'maestro'
      ? this.faklMcp(sessionId, profile)
      : (this.options.mcpFor?.(sessionId, [], profile) ?? []);
  }

  private faklMcp(sessionId: string, profile: AgentProfile): McpServerRef[] {
    return this.options.mcpFor?.(sessionId, ['maestro', 'vault'], profile) ?? [];
  }

  private async startMaestro(
    state: RunState,
    profileId: string,
    base: string,
    previousSummary?: string,
  ): Promise<void> {
    const { task } = state;
    const extra = await (
      this.options.maestroContext?.(state.repoRoot) ?? Promise.resolve([])
    ).catch(() => []);
    const started = await this.options.agents.launch({
      profileId,
      cwd: state.repoRoot,
      worktree: { base },
      taskId: task.id,
      ...(task.permissoes ? { permissions: task.permissoes } : {}),
      extraMcp: (sessionId, profile) => this.faklMcp(sessionId, profile),
      systemPrompt: maestroPrompt({
        task,
        extra,
        ...this.resourcesContext(),
        limits: state.limits,
        branch: `fakl/${task.id}/${l10n.t('(your session)')}`,
        base: state.base,
        profiles: this.options.profiles(),
        history: state.run.rodadas,
        ...(previousSummary ? { previousSummary } : {}),
      }),
    });
    const branch = started.worktree?.branch ?? '';
    state.run.branch = branch;
    state.run.maestroSessionId = started.sessionId;
    state.run.agentes.push({
      sessionId: started.sessionId,
      profileId,
      papel: 'maestro',
      profundidade: 0,
      branch,
    });
    this.bySession.set(started.sessionId, state);
    this.sendTo(
      state,
      started.sessionId,
      state.run.rodadas.length > 0
        ? l10n.t(
            'Continue the task from where the previous work stopped. Start by looking at the state of your branch.',
          )
        : l10n.t('Start the task.'),
    );
  }

  private sendTo(state: RunState, sessionId: string, text: string): void {
    state.current.set(sessionId, '');
    state.turnDone.delete(sessionId);
    try {
      this.options.agents.send(sessionId, text);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
  }

  private startTimer(state: RunState): void {
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      void this.checkLimits(state);
    }, LIMIT_TICK_MS);
    state.timer.unref();
  }

  private resumeRun(state: RunState): Promise<null> {
    const existing = this.resuming.get(state.run.id);
    if (existing) return existing;
    const pending = this.resumeRunOnce(state).finally(() => this.resuming.delete(state.run.id));
    this.resuming.set(state.run.id, pending);
    return pending;
  }

  private async resumeRunOnce(state: RunState): Promise<null> {
    if (state.run.status === 'aguardando-decisão') {
      throw new RpcError(FaklErrorCode.Conflict, l10n.t('answer the pending decision first'));
    }
    const failedBranch =
      state.run.status === 'falhou' &&
      state.run.resultado === 'branch' &&
      this.tasks.get(state.task.id)?.status !== 'cancelada';
    if (!ACTIVE_RUN.has(state.run.status) && !failedBranch) {
      throw new RpcError(FaklErrorCode.Conflict, l10n.t('the run is {0}', state.run.status));
    }
    if (
      failedBranch &&
      [...this.runs.values()].some(
        (other) =>
          other !== state && other.task.id === state.task.id && ACTIVE_RUN.has(other.run.status),
      )
    ) {
      throw new RpcError(FaklErrorCode.Conflict, l10n.t('the task already has another active run'));
    }
    const maestro = state.run.maestroSessionId;
    const saved = new Set(this.options.agents.list().map((session) => session.sessionId));
    const alive = maestro ? this.options.agents.stateOf(maestro) : undefined;
    const previous = state.run.status;
    state.finishing = false;
    state.run.status = 'executando';
    delete state.run.fim;
    delete state.run.resultado;
    state.nudges = 0;
    try {
      const blocked = state.run.agentes.filter((agent) =>
        this.options.agents.recoveryOf(agent.sessionId),
      );
      const maestroAlive = alive !== undefined && !isFinalAgentState(alive);
      // Uma queda do Core sem limite pendente não deixa o maestro no meio de uma vez:
      // reabrir a sessão não continuaria nada, então um maestro novo segue o branch.
      if (maestro && saved.has(maestro) && (blocked.length > 0 || maestroAlive)) {
        // O runtime reabre o mesmo worktree e restaura a conversa ACP ou o diário.
        const ids = blocked.length > 0 ? blocked.map((agent) => agent.sessionId) : [maestro];
        await Promise.all(ids.map((id) => this.options.agents.resume(id)));
        if (blocked.length === 0 && maestroAlive) {
          await Promise.all(
            state.run.agentes
              .filter(
                (agent) =>
                  agent.sessionId !== maestro &&
                  this.options.agents.stateOf(agent.sessionId) === 'pausado',
              )
              .map((agent) => this.options.agents.resume(agent.sessionId)),
          );
        }
      } else {
        // Registros antigos não têm diário de agente: continuam o branch com o resumo disponível.
        if (state.task.origem === 'chat') {
          throw new RpcError(
            FaklErrorCode.Conflict,
            l10n.t('the conversation of this run has already ended'),
          );
        }
        if (!state.repoRoot) {
          state.repoRoot = await git(['rev-parse', '--show-toplevel'], state.task.repoPath);
          state.base =
            state.task.branchBase ??
            (await git(['rev-parse', '--abbrev-ref', 'HEAD'], state.repoRoot));
        }
        const profileId =
          state.run.agentes.find((agent) => agent.sessionId === maestro)?.profileId ??
          (await this.defaultMaestro());
        await this.startMaestro(state, profileId, state.run.branch || state.base, state.run.resumo);
      }
      if (!state.run.retomada) delete state.run.motivo;
      this.startTimer(state);
      // O runtime pode ter publicado outro limite durante a retomada.
      const status = state.run.status as RunStatus;
      await this.saveTask({
        ...this.task(state.task.id),
        status: status === 'pausada' ? 'pausada' : 'executando',
      });
      await this.saveRun(state);
      this.publishAgents(state);
      return null;
    } catch (error) {
      state.run.status = previous === 'falhou' ? 'falhou' : 'pausada';
      state.run.motivo = l10n.t(
        'could not resume: {0}',
        error instanceof Error ? error.message : String(error),
      );
      if (previous === 'falhou') state.run.resultado = 'branch';
      await this.saveRun(state);
      throw error;
    }
  }

  // ---------------------------------------------------------------- ferramentas do maestro

  private async listProfiles(caller: { state: RunState }): Promise<unknown> {
    const fixed = caller.state.task.papeisFixados ?? {};
    const permitted = caller.state.task.perfisPermitidos;
    // Um perfil cujo agente não está instalado falharia no spawn_agent; o maestro precisa saber antes.
    const availability = new Map(
      (await this.options.agents.detect().catch(() => [])).map((a) => [a.id, a.availability]),
    );
    return this.options
      .profiles()
      .filter((profile) => !permitted || permitted.includes(profile.id))
      .map((profile) => ({
        id: profile.id,
        nome: profile.nome,
        provedor: profile.provedor,
        ...(profile.modelo ? { modelo: profile.modelo } : {}),
        pontosFortes: profile.pontosFortes ?? [],
        custoRelativo: profile.custoRelativo ?? 'médio',
        podeSerMaestro: profile.podeSerMaestro ?? false,
        bloqueado: this.options.costs.blockedReason(profile.provedor) ?? null,
        instalado: availability.get(profile.id)?.status !== 'não-instalado',
        ...(this.options.scorecard
          ? { placar: this.options.scorecard.summaryFor(profile.id) }
          : {}),
        ...(availability.get(profile.id)?.status === 'não-instalado' &&
        availability.get(profile.id)?.install
          ? { comoInstalar: availability.get(profile.id)?.install }
          : {}),
        papeisFixados: Object.entries(fixed)
          .filter(([, id]) => id === profile.id)
          .map(([papel]) => papel),
      }));
  }

  private async spawnAgent(
    caller: { state: RunState; agent: RunAgent; sessionId: string },
    p: Record<string, unknown>,
  ): Promise<unknown> {
    const { state } = caller;
    const papel = typeof p.papel === 'string' && p.papel ? p.papel : 'executor';
    const instrucoes = stringParam(p, 'instrucoes');
    const resources = await this.spawnResources(p);
    const profileId = this.spawnProfile(state, p, resources, caller.agent.profileId);
    const profile = this.options.profiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw RpcError.notFound(l10n.t('profile {0} does not exist; see list_profiles', profileId));
    }
    const permitted = state.task.perfisPermitidos;
    if (permitted && !permitted.includes(profileId)) {
      throw RpcError.invalidParams(
        l10n.t(
          'profile {0} is not among the models allowed for delegation in this task',
          profileId,
        ),
      );
    }
    const fixed = state.task.papeisFixados?.[papel];
    if (fixed && fixed !== profileId) {
      throw RpcError.invalidParams(l10n.t('the role {0} is pinned to profile {1}', papel, fixed));
    }
    const reviewProfile = state.task.criterio?.revisao?.perfil;
    if (papel === 'revisor' && reviewProfile && reviewProfile !== profileId) {
      throw RpcError.invalidParams(
        l10n.t('the review of this task belongs to profile {0}', reviewProfile),
      );
    }
    const profundidade = caller.agent.profundidade + 1;
    const maxDepth = state.limits.profundidadeMaxima ?? 2;
    if (papel === 'maestro') {
      if (!profile.podeSerMaestro) {
        throw RpcError.invalidParams(l10n.t('profile {0} cannot be a maestro', profileId));
      }
      if (profundidade > maxDepth) {
        throw new RpcError(
          FaklErrorCode.LimitExceeded,
          l10n.t('maximum maestro depth ({0}) reached; delegate as an executor', String(maxDepth)),
        );
      }
    }
    const hit = this.limitHit(state);
    if (hit) {
      throw new RpcError(
        FaklErrorCode.LimitExceeded,
        l10n.t('limit of {0} reached; agents cannot be created', hit.limite),
      );
    }
    // O subagente parte do que o maestro já fez, então o trabalho dele vai para o branch antes.
    const callerTree = this.options.agents.worktree(caller.sessionId);
    if (callerTree) {
      await commitWorktree(callerTree, l10n.t('fakl: maestro work before delegating'));
    }
    const base = callerTree?.branch ?? (state.run.branch || state.base);
    const criterio = typeof p.criterio === 'string' ? p.criterio : undefined;
    const started = await this.options.agents.launch({
      profileId,
      cwd: state.repoRoot,
      worktree: { base },
      taskId: state.task.id,
      ...this.permissionsFor(state),
      systemPrompt:
        papel === 'maestro'
          ? maestroPrompt({
              task: { ...state.task, descricao: instrucoes },
              limits: state.limits,
              branch: '(seu branch)',
              base,
              profiles: this.options.profiles(),
              ...this.resourcesContext(),
              extra: resources.length > 0 ? [resourcesBriefing(resources)] : [],
            })
          : workerPrompt(state.task, papel, criterio, resources),
      // Subagente comum só leva as integrações: as ferramentas de orquestração do chat não são dele.
      extraMcp: (id: string, profile: AgentProfile) =>
        papel === 'maestro'
          ? this.faklMcp(id, profile)
          : (this.options.mcpFor?.(id, [], profile) ?? []),
    });
    const agent: RunAgent = {
      sessionId: started.sessionId,
      profileId,
      papel,
      parentSessionId: caller.sessionId,
      profundidade,
      ...(started.worktree ? { branch: started.worktree.branch } : {}),
    };
    state.run.agentes.push(agent);
    this.bySession.set(started.sessionId, state);
    await this.saveRun(state);
    this.publishAgents(state);
    this.sendTo(state, started.sessionId, instrucoes);
    return {
      sessionId: started.sessionId,
      branch: agent.branch ?? null,
      profileId,
      ...(resources.length > 0
        ? { recursos: resources.map(({ info }) => `${info.kind}:${info.name}`) }
        : {}),
    };
  }

  /** `agente` e `skills` do spawn_agent, lidos da biblioteca ou do catálogo. */
  private async spawnResources(p: Record<string, unknown>): Promise<ResourceContent[]> {
    const wanted: { kind: ResourceKind; name: string }[] = [];
    if (p.agente !== undefined) {
      if (typeof p.agente !== 'string' || !p.agente) {
        throw RpcError.invalidParams(l10n.t('agente must be the name (slug) of an agent'));
      }
      wanted.push({ kind: 'agent', name: p.agente });
    }
    for (const name of strings(p.skills, 'skills') ?? []) wanted.push({ kind: 'skill', name });
    if (wanted.length === 0) return [];
    const resolve = this.options.resource;
    if (!resolve) {
      throw RpcError.invalidParams(l10n.t('the agents and skills library is not active'));
    }
    return Promise.all(wanted.map(({ kind, name }) => resolve(kind, name)));
  }

  /**
   * profileId explícito vence; sem ele, o perfil sugerido pelo agente (ou pela
   * primeira skill) que exista e seja permitido nesta tarefa. Um recurso feito
   * para outra máquina sugere perfis que aqui não existem: aí vale um parente
   * dele (`claude-sonnet` → `claude`) ou o perfil de quem delega.
   */
  private spawnProfile(
    state: RunState,
    p: Record<string, unknown>,
    resources: readonly ResourceContent[],
    callerProfileId: string,
  ): string {
    if (p.profileId !== undefined) return stringParam(p, 'profileId');
    const permitted = state.task.perfisPermitidos;
    const allowed = this.options
      .profiles()
      .map((profile) => profile.id)
      .filter((id) => !permitted || permitted.includes(id));
    const suggested = resources.map(({ info }) => info.perfil).filter((id): id is string => !!id);
    if (suggested.length === 0) {
      throw RpcError.invalidParams(
        l10n.t('pass profileId (see list_profiles) or an agent/skill with a suggested profile'),
      );
    }
    const fallback = fallbackProfile(suggested, allowed, callerProfileId);
    if (fallback) return fallback;
    throw RpcError.invalidParams(
      l10n.t(
        'the suggested profile ({0}) does not exist or is not allowed in this task; pass profileId (see list_profiles)',
        suggested.join(', '),
      ),
    );
  }

  private async awaitResults(
    caller: { state: RunState; sessionId: string },
    p: Record<string, unknown>,
  ): Promise<unknown> {
    const { state } = caller;
    const ids = stringArrayParam(p, 'sessionIds');
    for (const id of ids) this.child(caller, id, false);
    const timeoutSeg = typeof p.timeoutSeg === 'number' && p.timeoutSeg > 0 ? p.timeoutSeg : 900;
    const done = (id: string): boolean => {
      if (this.options.agents.recoveryOf(id)) return false;
      const s = this.options.agents.stateOf(id);
      return s === undefined || isFinalAgentState(s) || state.turnDone.has(id);
    };
    await this.until(
      () => ids.every((id) => done(id) || this.options.agents.recoveryOf(id)),
      timeoutSeg * 1000,
    );
    return Promise.all(
      ids.map(async (id) => {
        const agent = state.run.agentes.find((a) => a.sessionId === id);
        const terminou = done(id);
        const tree = this.options.agents.worktree(id);
        if (terminou && tree) {
          await this.options.agents.settled(id);
          if (!isFinalAgentState(this.options.agents.stateOf(id) ?? 'parado')) {
            await commitWorktree(tree, l10n.t('fakl: work by {0}', agent?.profileId ?? id)).catch(
              () => false,
            );
          }
        }
        const usage = this.options.costs.sessionTotals([id]);
        return {
          sessionId: id,
          terminou,
          ...(this.options.agents.recoveryOf(id)
            ? { retomada: this.options.agents.recoveryOf(id) }
            : {}),
          estado: this.options.agents.stateOf(id) ?? 'parado',
          resumo: truncate(state.lastReply.get(id) ?? state.current.get(id) ?? '', REPLY_LIMIT),
          branch: agent?.branch ?? null,
          diffStat:
            agent?.branch && tree ? await this.diffStat(state, tree.base, agent.branch) : '',
          custo: usage,
        };
      }),
    );
  }

  private async diffStat(state: RunState, base: string, branch: string): Promise<string> {
    return git(['diff', '--shortstat', `${base}...${branch}`], state.repoRoot).catch(() => '');
  }

  private async reviewDiff(
    caller: { state: RunState; sessionId: string },
    sessionId: string,
  ): Promise<unknown> {
    const agent = this.child(caller, sessionId, false);
    const tree = this.options.agents.worktree(sessionId);
    if (!tree || !agent.branch) {
      throw RpcError.invalidParams(l10n.t('this session has no worktree'));
    }
    await this.options.agents.settled(sessionId);
    if (!isFinalAgentState(this.options.agents.stateOf(sessionId) ?? 'parado')) {
      await commitWorktree(tree, l10n.t('fakl: work by {0}', agent.profileId)).catch(() => false);
    }
    const diff = await git(['diff', `${tree.base}...${agent.branch}`], caller.state.repoRoot);
    return { branch: agent.branch, diff: truncate(diff, DIFF_LIMIT) };
  }

  private async mergeWork(
    caller: { state: RunState; sessionId: string },
    ids: readonly string[],
  ): Promise<unknown> {
    const tree = this.options.agents.worktree(caller.sessionId);
    if (!tree) {
      throw RpcError.invalidParams(
        l10n.t(
          'you work directly in the folder, without a worktree: merge each branch with "git merge <branch>" (the branch comes from spawn_agent and await_results)',
        ),
      );
    }
    await commitWorktree(tree, l10n.t('fakl: maestro work before merging'));
    const results: unknown[] = [];
    for (const id of ids) {
      const agent = this.child(caller, id, false);
      const childTree = this.options.agents.worktree(id);
      if (!agent.branch || !childTree) {
        results.push({ sessionId: id, ok: false, erro: l10n.t('no branch') });
        continue;
      }
      await this.options.agents.settled(id);
      if (!isFinalAgentState(this.options.agents.stateOf(id) ?? 'parado')) {
        await commitWorktree(childTree, l10n.t('fakl: work by {0}', agent.profileId)).catch(
          () => false,
        );
      }
      const merged = await exec(
        'git',
        [
          '-c',
          'user.name=FaKL-Code',
          '-c',
          'user.email=fakl-code@localhost',
          'merge',
          '--no-ff',
          '--no-edit',
          agent.branch,
        ],
        { cwd: tree.path },
      );
      if (merged.code === 0) {
        results.push({ sessionId: id, ok: true, branch: agent.branch });
        continue;
      }
      const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], tree.path).catch(
        () => '',
      );
      await exec('git', ['merge', '--abort'], { cwd: tree.path });
      results.push({
        sessionId: id,
        ok: false,
        branch: agent.branch,
        conflitos: conflicts.split('\n').filter(Boolean),
        erro: l10n.t('conflict: delegate the resolution or merge by hand in your worktree'),
      });
    }
    return results;
  }

  /** Critério de pronto no worktree de quem chamou. Sem lista explícita, é uma rodada. */
  private async runChecks(
    caller: { state: RunState; sessionId: string },
    explicit: readonly string[] | undefined,
  ): Promise<unknown> {
    const { state } = caller;
    const tree = this.options.agents.worktree(caller.sessionId);
    const cwd = tree?.path ?? state.repoRoot;
    if (explicit?.length) {
      return { verificacoes: await this.check(explicit, cwd) };
    }
    const round = await this.round(state, cwd);
    if (!round) {
      return {
        erro: l10n.t('round limit reached; the run followed the configured policy'),
      };
    }
    return round;
  }

  private async check(commands: readonly string[], cwd: string): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const command of commands) {
      const started = Date.now();
      const result = await runShell(command, {
        cwd,
        timeoutMs: CHECK_TIMEOUT_MS,
        tailChars: CHECK_TAIL,
      });
      results.push({
        nome: command,
        ok: result.code === 0,
        saida: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`
          .trim()
          .slice(-CHECK_TAIL),
        duracaoMs: Date.now() - started,
      });
    }
    return results;
  }

  /** Uma rodada: confere o limite de rodadas, roda os comandos do critério e grava. */
  private async round(state: RunState, cwd: string): Promise<Round | undefined> {
    const rule = state.limits.rodadas;
    if (rule && state.run.rodadas.length >= rule.valor) {
      await this.applyLimit(state, {
        limite: 'rodadas',
        valor: rule.valor,
        atual: state.run.rodadas.length,
        acao: rule.acao ?? 'perguntar',
      });
      const after = state.limits.rodadas;
      if (!ACTIVE_RUN.has(state.run.status) || (after && state.run.rodadas.length >= after.valor)) {
        return undefined;
      }
    }
    const numero = state.run.rodadas.length + 1;
    const inicio = now(this.clock);
    this.options.bus.publish('run.round', state.run.id, {
      runId: state.run.id,
      rodada: numero,
      inicio: true,
    });
    const verificacoes = await this.check(state.task.criterio?.comandos ?? [], cwd);
    const round: Round = {
      numero,
      inicio,
      fim: now(this.clock),
      verificacoes,
      veredito: verificacoes.every((c) => c.ok) ? 'passou' : 'falhou',
    };
    state.run.rodadas.push(round);
    state.lastRoundTree = await treeFingerprint(cwd);
    await this.saveRun(state);
    this.options.bus.publish('run.round', state.run.id, { runId: state.run.id, ...round });
    return round;
  }

  private async finishFromMaestro(
    caller: { state: RunState; agent: RunAgent; sessionId: string },
    p: Record<string, unknown>,
  ): Promise<unknown> {
    const { state } = caller;
    const veredito = stringParam(p, 'veredito');
    const resumo = typeof p.resumo === 'string' ? p.resumo : '';
    if (caller.agent.parentSessionId) {
      // Um submaestro termina a subtarefa dele; quem entrega é o maestro principal.
      state.lastReply.set(caller.sessionId, `${veredito.toUpperCase()}: ${resumo}`);
      setTimeout(() => void this.options.agents.stop(caller.sessionId, 'maestro'), 0);
      return {
        ok: true,
        mensagem: l10n.t('subtask ended; the maestro above receives the summary'),
      };
    }
    if (veredito !== 'sucesso') {
      setTimeout(
        () => void this.finalize(state, 'falha', resumo || l10n.t('the maestro gave up'), 'branch'),
        0,
      );
      return { ok: true, mensagem: l10n.t('run ended as a failure') };
    }
    const review = state.task.criterio?.revisao;
    if (review?.exigeAprovacao) {
      const approved = state.run.agentes.some(
        (a) =>
          a.papel === 'revisor' &&
          (!review.perfil || a.profileId === review.perfil) &&
          /(?:VERDICT|VEREDITO):\s*(?:APPROVED|APROVADO)/i.test(
            state.lastReply.get(a.sessionId) ?? '',
          ),
      );
      if (!approved) {
        return {
          ok: false,
          erro: review.perfil
            ? l10n.t(
                'approval from a reviewer with profile {0} is missing ("VERDICT: APPROVED")',
                review.perfil,
              )
            : l10n.t('approval from a reviewer is missing ("VERDICT: APPROVED")'),
        };
      }
    }
    if (state.task.criterio?.comandos?.length) {
      const tree = this.options.agents.worktree(caller.sessionId);
      const cwd = tree?.path ?? state.repoRoot;
      const last = state.run.rodadas.at(-1);
      // A última rodada passou e nada mudou desde então: vale como a rodada final.
      const unchanged =
        last?.veredito === 'passou' &&
        state.lastRoundTree !== undefined &&
        state.lastRoundTree === (await treeFingerprint(cwd));
      const round = unchanged ? last : await this.round(state, cwd);
      if (!round) return { ok: false, erro: l10n.t('round limit reached') };
      if (round.veredito !== 'passou') {
        return {
          ok: false,
          erro: l10n.t('the done criteria did not pass; fix it and call finish again'),
          falhas: round.verificacoes.filter((c) => !c.ok),
        };
      }
    }
    const entrega = state.task.entrega ?? this.options.defaults?.().entrega ?? DEFAULT_DELIVERY;
    setTimeout(() => void this.finalize(state, 'sucesso', resumo, entrega), 0);
    return { ok: true, mensagem: l10n.t('criteria passed; delivering ({0})', entrega) };
  }

  // ---------------------------------------------------------------- decisões e limites

  /**
   * Modo de permissão da execução: o da tarefa ou, sem ele, o do maestro, que
   * você pode trocar no chat com a execução rodando.
   */
  private mode(state: RunState): PermissionPolicyName | undefined {
    const maestro = state.run.maestroSessionId;
    return state.task.permissoes ?? (maestro ? this.options.agents.modeOf(maestro) : undefined);
  }

  private permissionsFor(state: RunState): { permissions?: PermissionPolicyName } {
    const mode = this.mode(state);
    return mode ? { permissions: mode } : {};
  }

  /**
   * Pergunta ao usuário. No autopilot, quem pergunta diz a opção segura em
   * `autopilot` e ela vale na hora; a decisão fica registrada como respondida.
   */
  private ask(
    state: RunState,
    pergunta: string,
    opcoes: readonly DecisionOption[],
    extra: { sessionId?: string; limite?: LimitName; autopilot?: string } = {},
  ): Promise<string> {
    const { autopilot, ...rest } = extra;
    const decision: Mutable<Decision> = {
      id: ulid(),
      runId: state.run.id,
      pergunta,
      opcoes,
      criadaEm: now(this.clock),
      ...rest,
    };
    state.run.decisoes.push(decision);
    if (autopilot !== undefined && this.mode(state) === 'autopilot') {
      decision.escolha = autopilot;
      decision.respondidaEm = decision.criadaEm;
      decision.origemResposta = 'autopilot';
      void this.saveRun(state);
      this.options.bus.publish('run.decision', state.run.id, decision);
      this.options.log?.(
        l10n.t('run {0}: autopilot chose {1} in "{2}"', state.run.id, autopilot, pergunta),
      );
      return Promise.resolve(autopilot);
    }
    const previous = state.run.status;
    state.run.status = 'aguardando-decisão';
    void this.saveRun(state);
    this.options.bus.publish('run.decision', state.run.id, decision);
    return new Promise((resolve) => {
      state.waiters.set(decision.id, (choice) => {
        if (state.run.status === 'aguardando-decisão') {
          state.run.status = previous === 'aguardando-decisão' ? 'executando' : previous;
        }
        resolve(choice);
      });
    });
  }

  private consumption(state: RunState): Parameters<typeof exceeded>[1] {
    const totals = this.options.costs.sessionTotals(state.run.agentes.map((a) => a.sessionId));
    return {
      rodadas: 0,
      tempoMin: (this.clock().getTime() - state.startedAt) / 60_000,
      tokens: totals.tokensEntrada + totals.tokensSaida,
      custoUsd: totals.custoUsd,
    };
  }

  private limitHit(state: RunState): ReturnType<typeof exceeded> {
    return exceeded(state.limits, this.consumption(state));
  }

  private async checkLimits(state: RunState): Promise<void> {
    if (state.run.status !== 'executando' || state.limitPending || state.finishing) return;
    const hit = this.limitHit(state);
    if (hit) await this.applyLimit(state, hit, true);
  }

  /** Aplica a política do limite estourado (SDD 9.3). */
  private async applyLimit(
    state: RunState,
    hit: NonNullable<ReturnType<typeof exceeded>>,
    pauseAgents = false,
  ): Promise<void> {
    if (state.limitPending) return;
    state.limitPending = true;
    try {
      const data: RunLimitEventData = { tipo: 'execucao', runId: state.run.id, ...hit };
      this.options.bus.publish('run.limit', state.run.id, data);
      this.options.log?.(l10n.t('run {0}: limit of {1} ({2})', state.run.id, hit.limite, hit.acao));
      let action = hit.acao;
      if (action === 'escalar' && !this.canEscalate(state)) action = 'perguntar';
      if (action === 'perguntar') {
        if (pauseAgents) await this.pauseAll(state);
        const options: DecisionOption[] = [
          { id: 'aumentar', rotulo: l10n.t('Increase the limit by 50% and continue') },
          { id: 'rascunho', rotulo: l10n.t('Deliver what exists as a draft') },
          ...(this.canEscalate(state)
            ? [
                {
                  id: 'escalar',
                  rotulo: l10n.t('Escalate to {0}', state.limits.perfilEscalada ?? ''),
                },
              ]
            : []),
          { id: 'descartar', rotulo: l10n.t('Discard the run') },
        ];
        const choice = await this.ask(
          state,
          l10n.t(
            'The task "{0}" reached the limit of {1} ({2} of {3}). What should be done?',
            state.task.titulo,
            hit.limite,
            String(Math.round(hit.atual * 100) / 100),
            String(hit.valor),
          ),
          options,
          { limite: hit.limite, autopilot: 'rascunho' },
        );
        action = choice === 'aumentar' ? 'perguntar' : (choice as typeof action);
        if (choice === 'aumentar') {
          state.limits = scaleLimits(state.limits, 1.5, hit.limite);
          await this.resumePaused(state);
          await this.saveRun(state);
          return;
        }
      }
      switch (action) {
        case 'rascunho':
          await this.finalize(state, 'rascunho', l10n.t('limit of {0} reached', hit.limite), 'pr');
          break;
        case 'escalar':
          await this.escalate(state);
          break;
        case 'descartar':
          await this.discard(state, l10n.t('limit of {0} reached', hit.limite), true);
          break;
        default:
          break;
      }
    } finally {
      state.limitPending = false;
    }
  }

  private canEscalate(state: RunState): boolean {
    const target = state.limits.perfilEscalada;
    return (
      !state.run.escalou &&
      target !== undefined &&
      this.options.profiles().some((p) => p.id === target)
    );
  }

  private async pauseAll(state: RunState): Promise<void> {
    state.pausedForLimit = state.run.agentes
      .map((a) => a.sessionId)
      .filter((id) => WORKING.has(this.options.agents.stateOf(id) ?? 'parado'));
    await Promise.all(state.pausedForLimit.map((id) => this.options.agents.pause(id)));
  }

  private async resumePaused(state: RunState): Promise<void> {
    const ids = state.pausedForLimit;
    state.pausedForLimit = [];
    await Promise.all(ids.map((id) => this.options.agents.resume(id).catch(() => undefined)));
  }

  /** Troca o maestro pelo perfil de escalada, com orçamento extra, uma vez por execução. */
  private async escalate(state: RunState): Promise<void> {
    const target = state.limits.perfilEscalada;
    if (!target) return;
    await this.stopAgents(state);
    state.run.escalou = true;
    state.limits = scaleLimits(state.limits, state.limits.orcamentoExtra ?? 1.5);
    state.startedAt = this.clock().getTime();
    state.run.status = 'executando';
    await this.startMaestro(
      state,
      target,
      state.run.branch || state.base,
      l10n.t('run escalated because of a limit'),
    );
    await this.saveRun(state);
  }

  private async stopAgents(state: RunState): Promise<void> {
    const ids = state.run.agentes.map((a) => a.sessionId);
    await Promise.all(
      ids.map((id) => this.options.agents.stop(id, 'maestro').catch(() => undefined)),
    );
    await Promise.all(ids.map((id) => this.options.agents.settled(id)));
  }

  /** Para tudo e apaga os branches da execução. */
  private async discard(state: RunState, motivo: string, deleteBranches: boolean): Promise<void> {
    if (state.finishing) return;
    state.finishing = true;
    clearInterval(state.timer);
    for (const [id, resolve] of state.waiters) {
      resolve('cancelada');
      state.waiters.delete(id);
    }
    await this.stopAgents(state);
    if (deleteBranches && state.repoRoot) {
      for (const agent of state.run.agentes) {
        if (agent.branch) await deleteBranch(state.repoRoot, agent.branch, this.options.log);
      }
    }
    state.run.resultado = 'descartado';
    state.run.motivo = motivo;
    state.run.fim = now(this.clock);
    await this.closeRun(state, 'descartada', 'falhou');
  }

  /** Encerra a execução: para os agentes, entrega e grava (RF-209). */
  /** Espera as execuções que estão terminando gravarem tudo (ao fechar o Core). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.finishing]);
  }

  private finalize(
    state: RunState,
    how: 'sucesso' | 'falha' | 'rascunho',
    resumo: string,
    entrega: Delivery,
  ): Promise<void> {
    const done = this.finish(state, how, resumo, entrega).finally(() => {
      this.finishing.delete(done);
    });
    this.finishing.add(done);
    return done;
  }

  private async finish(
    state: RunState,
    how: 'sucesso' | 'falha' | 'rascunho',
    resumo: string,
    entrega: Delivery,
  ): Promise<void> {
    if (state.finishing) return;
    state.finishing = true;
    clearInterval(state.timer);
    for (const [id, resolve] of state.waiters) {
      resolve('cancelada');
      state.waiters.delete(id);
    }
    await this.stopAgents(state);
    state.run.resumo = resumo;
    state.run.fim = now(this.clock);
    if (how === 'falha') {
      state.run.resultado = 'branch';
      state.run.motivo = resumo;
      await this.closeRun(state, 'falhou', 'falhou');
      return;
    }
    try {
      const delivered = await this.deliver(
        state,
        how === 'rascunho' ? 'rascunho' : entrega,
        resumo,
      );
      state.run.resultado = delivered.resultado;
      if (delivered.prUrl) state.run.prUrl = delivered.prUrl;
      if (delivered.buildUrl) state.run.buildUrl = delivered.buildUrl;
      if (delivered.motivo) state.run.motivo = delivered.motivo;
    } catch (error) {
      state.run.resultado = 'branch';
      state.run.motivo = l10n.t(
        'could not deliver: {0}',
        error instanceof Error ? error.message : String(error),
      );
    }
    const status = how === 'rascunho' ? 'falhou' : 'concluída';
    await this.closeRun(state, status, status);
  }

  /**
   * Grava a execução e a tarefa já encerradas e só então troca os dois status
   * e publica `run.done`, no mesmo tick: quem lê `runs.get` nunca vê a
   * execução encerrada com a tarefa ainda executando ou antes do evento. Se a
   * gravação falhar, a execução encerra do mesmo jeito (e o erro segue).
   */
  private async closeRun(
    state: RunState,
    runStatus: RunStatus,
    taskStatus: TaskStatus,
  ): Promise<void> {
    const task = this.tasks.get(state.task.id);
    const closed =
      task && task.status !== 'cancelada' ? { ...task, status: taskStatus } : undefined;
    try {
      const runFile = this.runFile(state.run.id);
      if (runFile) await writeJsonAtomic(runFile, { ...state.run, status: runStatus });
      const taskFile = closed && this.taskFile(closed.id);
      if (taskFile) await writeJsonAtomic(taskFile, closed);
    } finally {
      state.run.status = runStatus;
      // Cancelada durante a gravação: o cancelamento vale (e a gravação dele vem depois).
      if (closed && this.tasks.get(closed.id)?.status !== 'cancelada') {
        this.tasks.set(closed.id, closed);
      }
      this.changed();
      this.options.bus.publish('run.done', state.run.id, state.run);
    }
  }

  private async deliver(
    state: RunState,
    mode: Delivery | 'rascunho',
    resumo: string,
  ): Promise<{
    resultado: NonNullable<Run['resultado']>;
    prUrl?: string;
    buildUrl?: string;
    motivo?: string;
  }> {
    const { repoRoot, base } = state;
    const branch = state.run.branch;
    if (!branch) return { resultado: 'branch', motivo: l10n.t('the run has no branch') };
    const ahead = await git(['rev-list', '--count', `${base}..${branch}`], repoRoot).catch(
      () => '0',
    );
    if (ahead === '0') {
      return { resultado: 'branch', motivo: l10n.t('no changes to deliver') };
    }

    if (mode === 'merge') {
      const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).catch(() => '');
      const dirty = await git(['status', '--porcelain', '--untracked-files=no'], repoRoot).catch(
        () => 'x',
      );
      if (current !== base || dirty) {
        return {
          resultado: 'branch',
          motivo:
            current !== base
              ? l10n.t(
                  'merge not done: the folder is on branch {0}; the work is in {1}',
                  current,
                  branch,
                )
              : l10n.t(
                  'merge not done: the folder has uncommitted changes; the work is in {0}',
                  branch,
                ),
        };
      }
      const merged = await exec(
        'git',
        ['merge', '--no-ff', '-m', `fakl: ${state.task.titulo}`, branch],
        {
          cwd: repoRoot,
        },
      );
      if (merged.code !== 0) {
        await exec('git', ['merge', '--abort'], { cwd: repoRoot });
        return {
          resultado: 'branch',
          motivo: l10n.t('merge with conflict; the work is in {0}', branch),
        };
      }
      // Projeto Lovable: o branch acompanhado vai para o GitHub, e o Lovable mostra a mudança.
      const lovable = await this.options.lovable?.(repoRoot).catch(() => undefined);
      if (lovable?.branch === base) {
        const blocked = await this.secretGate(state, base, branch);
        if (blocked) return { resultado: 'merge', motivo: blocked };
        const pushed = await exec('git', ['push', 'origin', base], {
          cwd: repoRoot,
          timeoutMs: 120_000,
          env: this.options.github?.gitEnv() ?? {},
        });
        if (pushed.code !== 0) {
          return {
            resultado: 'merge',
            motivo: l10n.t(
              'merge done; the push to Lovable failed: {0}',
              (pushed.stderr || pushed.stdout).trim().slice(-300),
            ),
          };
        }
        return { resultado: 'merge', motivo: l10n.t('sent to Lovable ({0})', lovable.url) };
      }
      return { resultado: 'merge' };
    }

    if (mode === 'branch') return { resultado: 'branch' };

    // PR, rascunho ou PR + merge: o branch vai para o GitHub.
    const draft = mode === 'rascunho';
    const blocked = await this.secretGate(state, base, branch);
    if (blocked) return { resultado: 'branch', motivo: blocked };
    const pushed = await exec('git', ['push', '-u', 'origin', branch], {
      cwd: repoRoot,
      timeoutMs: 120_000,
      env: this.options.github?.gitEnv() ?? {},
    });
    if (pushed.code !== 0) {
      return {
        resultado: 'branch',
        motivo: l10n.t('push failed: {0}', (pushed.stderr || pushed.stdout).trim().slice(-500)),
      };
    }
    const title = deliveryTitle(
      state.task.titulo,
      await this.branchSubjects(repoRoot, base, branch),
    );
    const opened = await this.openPull(state, branch, base, resumo, draft, title);
    if ('motivo' in opened) {
      return { resultado: draft ? 'rascunho' : 'branch', motivo: opened.motivo };
    }
    if (mode !== 'pr-merge') return { resultado: draft ? 'rascunho' : 'pr', prUrl: opened.url };

    const notMerged = await this.mergePull(state, opened.url, opened.number, title);
    if (notMerged !== undefined) {
      return {
        resultado: 'pr',
        prUrl: opened.url,
        motivo: l10n.t('PR opened; the merge into {0} was not done: {1}', base, notMerged),
      };
    }
    // O merge foi no GitHub; a pasta do usuário não muda, quem faz o pull é ele.
    const build = await this.dispatchBuild(state, branch);
    return {
      resultado: 'merge',
      prUrl: opened.url,
      ...(build.url ? { buildUrl: build.url } : {}),
      motivo: l10n.t('PR merged into {0}; {1}', base, build.motivo),
    };
  }

  /** Assuntos dos commits do branch, do mais antigo ao mais novo. */
  private async branchSubjects(repoRoot: string, base: string, branch: string): Promise<string[]> {
    const log = await exec('git', ['log', '--reverse', '--format=%s', `${base}..${branch}`], {
      cwd: repoRoot,
      timeoutMs: 30_000,
    });
    return log.code === 0 ? log.stdout.split('\n').filter(Boolean) : [];
  }

  /** Abre o PR do branch pela API do GitHub ou, sem ela, pelo `gh`. */
  private async openPull(
    state: RunState,
    branch: string,
    base: string,
    resumo: string,
    draft: boolean,
    title: string,
  ): Promise<{ url: string; number?: number } | { motivo: string }> {
    const body = this.prBody(state, resumo);
    const github = this.options.github;
    if (github?.connected) {
      try {
        const created = await github.createPull(state.repoRoot, {
          title,
          head: branch,
          base,
          body,
          draft,
        });
        return {
          url: created.html_url,
          ...(created.number !== undefined ? { number: created.number } : {}),
        };
      } catch (error) {
        this.options.log?.(l10n.t('PR through the API failed, trying gh: {0}', String(error)));
      }
    }
    const pr = await exec(
      'gh',
      [
        'pr',
        'create',
        ...(draft ? ['--draft'] : []),
        '--base',
        base,
        '--head',
        branch,
        '--title',
        title,
        '--body',
        body,
      ],
      { cwd: state.repoRoot, timeoutMs: 120_000 },
    );
    const url = /https:\/\/\S+/.exec(pr.stdout)?.[0];
    if (pr.code !== 0 || !url) {
      return {
        motivo: l10n.t(
          'branch {0} pushed; could not open the PR ({1})',
          branch,
          pr.code === -1 ? l10n.t('gh not found') : (pr.stderr || pr.stdout).trim().slice(-300),
        ),
      };
    }
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    return { url, ...(Number.isInteger(number) && number > 0 ? { number } : {}) };
  }

  /**
   * Merge (squash) do PR recém-aberto. O GitHub ainda calcula se o PR pode ser
   * mesclado logo depois de criá-lo, então tenta de novo algumas vezes.
   * Devolve o motivo da falha, ou `undefined` se mesclou.
   */
  private async mergePull(
    state: RunState,
    url: string,
    number: number | undefined,
    title: string,
  ): Promise<string | undefined> {
    const github = this.options.github;
    let motivo = l10n.t('no access to GitHub');
    let hasGh = true;
    for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, MERGE_RETRY_MS));
      if (github?.connected && github.mergePull && number !== undefined) {
        try {
          const merged = await github.mergePull(state.repoRoot, number, title);
          if (merged.merged) return undefined;
          motivo = merged.message;
          continue;
        } catch (error) {
          // Sem permissão pela API, o gh do usuário ainda pode ter.
          motivo = error instanceof Error ? error.message : String(error);
          this.options.log?.(l10n.t('PR merge through the API failed: {0}', motivo));
        }
      }
      if (!hasGh) continue;
      const gh = await exec('gh', ['pr', 'merge', url, '--squash'], {
        cwd: state.repoRoot,
        timeoutMs: 120_000,
      });
      if (gh.code === -1) {
        hasGh = false;
        if (!github?.connected) return l10n.t('gh not found');
        continue;
      }
      if (gh.code !== 0) {
        motivo = (gh.stderr || gh.stdout).trim().slice(-300);
        continue;
      }
      // Com fila de merge ou auto-merge, o gh só enfileira: confere se mesclou.
      const view = await exec('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state'], {
        cwd: state.repoRoot,
        timeoutMs: 60_000,
      });
      if (view.stdout.trim() === 'MERGED') return undefined;
      return l10n.t(
        'the PR entered the merge queue ({0}); the build was not triggered',
        view.stdout.trim() || l10n.t('unknown state'),
      );
    }
    return motivo;
  }

  /**
   * Dispara o workflow de `buildAposMerge` no branch base, se o config.yaml o
   * pedir e o repositório tiver esse workflow com `workflow_dispatch`. Só vão
   * as entradas que o workflow declara.
   */
  private async dispatchBuild(
    state: RunState,
    branch: string,
  ): Promise<{ url?: string; motivo: string }> {
    const build = this.options.defaults?.().buildAposMerge;
    if (!build) return { motivo: l10n.t('no build configured (buildAposMerge)') };
    const { repoRoot, base } = state;
    const name = build.workflow;
    // O branch entregue é o que acabou de entrar no base.
    const workflow = await git(['show', `${branch}:.github/workflows/${name}`], repoRoot).catch(
      () => '',
    );
    if (!/^\s*workflow_dispatch\s*:/m.test(workflow)) {
      return {
        motivo: l10n.t('no {0} with workflow_dispatch; no build triggered', name),
      };
    }
    const declared = new Set([...workflow.matchAll(/^\s+([\w-]+)\s*:/gm)].map((match) => match[1]));
    const inputs = Object.fromEntries(
      Object.entries(build.inputs ?? {}).filter(([key]) => declared.has(key)),
    );
    const github = this.options.github;
    if (github?.connected && github.dispatchWorkflow) {
      try {
        const run = await github.dispatchWorkflow(repoRoot, name, base, inputs);
        return { url: run.html_url, motivo: l10n.t('{0} triggered ({1})', name, run.html_url) };
      } catch (error) {
        this.options.log?.(l10n.t('build through the API failed, trying gh: {0}', String(error)));
      }
    }
    const gh = await exec(
      'gh',
      [
        'workflow',
        'run',
        name,
        '--ref',
        base,
        ...Object.entries(inputs).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
      ],
      { cwd: repoRoot, timeoutMs: 120_000 },
    );
    if (gh.code !== 0) {
      return {
        motivo: l10n.t(
          'the build was not triggered ({0})',
          gh.code === -1 ? l10n.t('gh not found') : (gh.stderr || gh.stdout).trim().slice(-300),
        ),
      };
    }
    const url = /https:\/\/\S+/.exec(gh.stdout)?.[0];
    return {
      ...(url ? { url } : {}),
      motivo: url ? l10n.t('{0} triggered ({1})', name, url) : l10n.t('{0} triggered', name),
    };
  }

  /**
   * Varredura de segredos antes do push (SDD 14.1): se o diff tiver algo com
   * cara de token ou chave, pergunta antes de enviar. Devolve o motivo de não
   * enviar, ou `undefined` para seguir.
   */
  private async secretGate(
    state: RunState,
    base: string,
    branch: string,
  ): Promise<string | undefined> {
    const diff = await exec('git', ['diff', `${base}...${branch}`], {
      cwd: state.repoRoot,
      tailChars: 2_000_000,
    });
    const added = diff.stdout
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .join('\n');
    const findings = scanSecrets(added, this.options.knownSecrets?.() ?? []);
    if (findings.length === 0) return undefined;
    const kinds = [...new Set(findings.map((f) => `${f.tipo} (${f.previa})`))].join(', ');
    const choice = await this.ask(
      state,
      l10n.t('The diff of {0} seems to contain secrets: {1}. Send anyway?', branch, kinds),
      [
        { id: 'nao', rotulo: l10n.t('Do not send; leave it on the local branch') },
        { id: 'enviar', rotulo: l10n.t('Send anyway') },
      ],
      { autopilot: 'nao' },
    );
    return choice === 'enviar'
      ? undefined
      : l10n.t('push canceled: possible secret in the diff ({0})', kinds);
  }

  private prBody(state: RunState, resumo: string): string {
    const maestro = state.run.agentes.find((a) => a.sessionId === state.run.maestroSessionId);
    const agents = [...new Set(state.run.agentes.map((a) => `${a.profileId} (${a.papel})`))];
    const rounds = state.run.rodadas
      .map(
        (r) =>
          `${l10n.t('- Round {0}: {1}', String(r.numero), r.veredito ?? '?')}${r.verificacoes.map((c) => ` · \`${c.nome}\` ${c.ok ? l10n.t('ok') : l10n.t('failed')}`).join('')}`,
      )
      .join('\n');
    return [
      [resumo, state.task.descricao].find(Boolean) ?? state.task.titulo,
      rounds ? `${l10n.t('### Checks')}\n${rounds}` : '',
      `${l10n.t('### Agents')}\n${agents.map((a) => `- ${a}`).join('\n')}`,
      maestro
        ? l10n.t('Made by FaKL-Code, with {0} as maestro.', maestro.profileId)
        : l10n.t('Made by FaKL-Code.'),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  // ---------------------------------------------------------------- eventos

  private onEvent(event: FaklEvent): void {
    if (event.topic === 'run.limit') {
      const data = event.data as Partial<DailyCapEventData>;
      if (data.tipo === 'teto-diario' && data.provedor) void this.onDailyCap(data.provedor);
      return;
    }
    const state = this.bySession.get(event.subject);
    if (!state) return;
    if (event.topic === 'agent.recovery') {
      const { retomada } = event.data as { retomada: AgentRecoveryInfo | null };
      this.onRecovery(state, event.subject, retomada);
      return;
    }
    if (event.topic === 'agent.output') {
      const data = event.data as AgentOutputEventData;
      if (data.kind === 'message') {
        state.current.set(event.subject, (state.current.get(event.subject) ?? '') + data.text);
      }
      return;
    }
    if (event.topic === 'cost.update') {
      void this.checkLimits(state);
      return;
    }
    if (event.topic !== 'agent.state') return;
    if (this.options.agents.recoveryOf(event.subject)) return;
    const { state: next, previous } = event.data as AgentStateEventData;
    const turnEnded =
      (WORKING.has(previous) || previous === 'pausado') && !WORKING.has(next) && next !== 'pausado';
    if (turnEnded || isFinalAgentState(next)) {
      state.turnDone.add(event.subject);
      const text = state.current.get(event.subject);
      if (text) state.lastReply.set(event.subject, text);
    }
    this.changed();
    if (event.subject === state.run.maestroSessionId) this.onMaestroState(state, next, turnEnded);
  }

  private onRecovery(state: RunState, sessionId: string, recovery: AgentRecoveryInfo | null): void {
    if (state.finishing || !ACTIVE_RUN.has(state.run.status)) return;
    if (recovery) {
      state.run.retomada = { ...recovery, sessionId };
      state.run.suspensaEm ??= now(this.clock);
      state.run.status = 'pausada';
      state.run.motivo = recovery.mensagem;
      state.turnDone.delete(sessionId);
      clearInterval(state.timer);
    } else {
      const another = state.run.agentes.find((agent) =>
        this.options.agents.recoveryOf(agent.sessionId),
      );
      const pending = another ? this.options.agents.recoveryOf(another.sessionId) : undefined;
      if (another && pending) {
        state.run.retomada = { ...pending, sessionId: another.sessionId };
      } else {
        delete state.run.retomada;
        if (state.run.suspensaEm) {
          const waited = Math.max(0, this.clock().getTime() - Date.parse(state.run.suspensaEm));
          state.run.esperaLimiteMs = (state.run.esperaLimiteMs ?? 0) + waited;
          state.startedAt += waited;
          delete state.run.suspensaEm;
        }
        state.run.status = 'executando';
        delete state.run.motivo;
        state.nudges = 0;
        this.startTimer(state);
      }
    }
    this.changed();
    this.publishAgents(state);
    const writing = this.saveRun(state)
      .then(async () => {
        if (!ACTIVE_RUN.has(state.run.status) || this.task(state.task.id).status === 'cancelada')
          return;
        await this.saveTask({
          ...this.task(state.task.id),
          status: state.run.status === 'pausada' ? 'pausada' : 'executando',
        });
      })
      .catch((error: unknown) => {
        this.options.log?.(l10n.t('could not save the resume state: {0}', String(error)));
      })
      .finally(() => this.finishing.delete(writing));
    this.finishing.add(writing);
  }

  private onMaestroState(state: RunState, next: AgentState, turnEnded: boolean): void {
    if (state.task.origem === 'chat') {
      // A conversa acabou: os subagentes dela param e o trabalho fica nos branches.
      if (isFinalAgentState(next) && !state.finishing) {
        void this.finalize(state, 'sucesso', l10n.t('the conversation ended'), 'branch');
      }
      return;
    }
    if (state.finishing || state.run.status !== 'executando') return;
    if (isFinalAgentState(next)) {
      // O maestro saiu sem chamar finish.
      void this.finalize(
        state,
        'falha',
        l10n.t('the maestro ended without finishing the task'),
        'branch',
      );
      return;
    }
    if (!turnEnded) return;
    // Deixa a chamada de finish, se veio nesta vez, se resolver antes do lembrete.
    setTimeout(() => {
      if (state.finishing || state.run.status !== 'executando' || state.limitPending) return;
      const maestro = state.run.maestroSessionId;
      if (!maestro || WORKING.has(this.options.agents.stateOf(maestro) ?? 'parado')) return;
      if (state.nudges < MAX_NUDGES) {
        state.nudges++;
        try {
          this.sendTo(
            state,
            maestro,
            l10n.t(
              'The task is not finished yet: you did not call finish. If you are waiting for subagents, use await_results. Keep going until you run run_checks and call finish.',
            ),
          );
        } catch {
          // Teto diário: a decisão vem pelo evento do teto.
        }
        return;
      }
      void this.ask(
        state,
        l10n.t(
          'The maestro of the task "{0}" stopped without finishing. What should be done?',
          state.task.titulo,
        ),
        [
          { id: 'continuar', rotulo: l10n.t('Ask it to continue') },
          { id: 'rascunho', rotulo: l10n.t('Deliver what exists as a draft') },
          { id: 'descartar', rotulo: l10n.t('Discard the run') },
        ],
        { autopilot: 'rascunho' },
      ).then(async (choice) => {
        if (choice === 'continuar') {
          state.nudges = 0;
          this.sendTo(state, maestro, l10n.t('Continue the task until you call finish.'));
        } else if (choice === 'rascunho') {
          await this.finalize(
            state,
            'rascunho',
            l10n.t('the maestro stopped without finishing'),
            'pr',
          );
        } else if (choice === 'descartar') {
          await this.discard(state, l10n.t('discarded by the user'), true);
        }
      });
    }, 1_000).unref();
  }

  private async onDailyCap(provedor: string): Promise<void> {
    const profiles = new Map(this.options.profiles().map((p) => [p.id, p.provedor]));
    for (const state of this.runs.values()) {
      if (state.run.status !== 'executando' || state.limitPending) continue;
      // No chat, o próprio chat mostra o teto; não há entrega para decidir.
      if (state.task.origem === 'chat') continue;
      if (!state.run.agentes.some((a) => profiles.get(a.profileId) === provedor)) continue;
      state.limitPending = true;
      try {
        const choice = await this.ask(
          state,
          l10n.t(
            'The daily cap for {0} was reached and the agents of that provider paused. What should be done with "{1}"?',
            provedor,
            state.task.titulo,
          ),
          [
            {
              id: 'esperar',
              rotulo: l10n.t('Leave it paused (resume after adjusting the cap)'),
            },
            { id: 'rascunho', rotulo: l10n.t('Deliver what exists as a draft') },
            { id: 'descartar', rotulo: l10n.t('Discard the run') },
          ],
          { autopilot: 'esperar' },
        );
        if (choice === 'rascunho')
          await this.finalize(state, 'rascunho', l10n.t('daily cap for {0}', provedor), 'pr');
        else if (choice === 'descartar')
          await this.discard(state, l10n.t('daily cap for {0}', provedor), true);
        else {
          state.run.status = 'pausada';
          state.run.motivo = l10n.t('daily cap for {0}', provedor);
          await this.saveRun(state);
        }
      } finally {
        state.limitPending = false;
      }
    }
  }
}
