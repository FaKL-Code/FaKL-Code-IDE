import type {
  AgentOutputEventData,
  AgentStateEventData,
  AgentThumbnailEventData,
  AgentToolEventData,
  CafeAgent,
  CafeState,
  CiStatus,
  FaklEvent,
} from '@fakl/protocol';

import type { AgentRuntime } from './agents.js';
import { localDay, type CostTracker } from './costs.js';
import type { Disposable, EventBus } from './events/bus.js';
import { run } from './exec.js';
import type { Orchestrator } from './orchestrator/orchestrator.js';
import type { CallContext, Router } from './rpc/router.js';

const TEST_COMMAND =
  /\b(test|tests|vitest|jest|pytest|mocha|spec|cargo test|go test|phpunit|rspec)\b/i;
const LINE = 64;
const LINES = 8;

interface Activity {
  thumbnail: AgentThumbnailEventData;
  /** Mudou desde a última publicação. */
  dirty: boolean;
  /** Arquivo cujo diff falta ler. */
  pendingFile?: string;
  thought: string;
  message: string;
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LINE ? `${flat.slice(0, LINE - 1)}…` : flat;
}

/** Últimas frases de um texto, em linhas curtas. */
function tail(text: string, count = 4): string[] {
  const sentences = text
    .split(/(?<=[.!?:])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.slice(-count).map(cut);
}

export interface CafeServiceOptions {
  readonly bus: EventBus;
  readonly agents: AgentRuntime;
  readonly orchestrator: Orchestrator;
  readonly costs: CostTracker;
  readonly intervalMs?: number;
  readonly clock?: () => Date;
  /** Cozinha do CI (ADR 0051): o retrato, ou nada se não há repositório acompanhado. */
  readonly ci?: () => CiStatus | undefined;
  /** Linhas mudadas de um arquivo do agente; muda nos testes. */
  readonly diffLines?: (cwd: string, path: string) => Promise<string[]>;
}

/** Linhas adicionadas e removidas de um arquivo, as últimas primeiro cortadas. */
async function gitDiffLines(cwd: string, path: string): Promise<string[]> {
  const result = await run('git', ['diff', '--no-color', '-U0', '--', path], {
    cwd,
    timeoutMs: 5_000,
    tailChars: 20_000,
  });
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line))
    .slice(-LINES)
    .map(cut);
}

/**
 * Lado do Core do cyber café (SDD 13): monta uma miniatura sintética do que
 * cada agente faz (arquivo e linhas mudadas, comando, testes, raciocínio) e a
 * publica como `agent.thumbnail` a cada 2 s, só enquanto alguma sala está
 * aberta. O café em si só consome eventos e `cafe.state`.
 */
export class CafeService {
  private readonly activities = new Map<string, Activity>();
  private readonly limits = new Set<string>();
  private readonly viewers = new Set<string>();
  private readonly subscription: Disposable;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly clock: () => Date;

  constructor(private readonly options: CafeServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.subscription = options.bus.subscribe(
      ['agent.state', 'agent.output', 'agent.tool', 'agent.file', 'run.limit', 'run.done'],
      (event) => {
        this.observe(event);
      },
    );
  }

  dispose(): void {
    this.subscription.dispose();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get open(): boolean {
    return this.viewers.size > 0;
  }

  private activity(sessionId: string): Activity {
    let activity = this.activities.get(sessionId);
    if (!activity) {
      activity = {
        thumbnail: { tipo: 'ocioso', titulo: 'ocioso', linhas: [] },
        dirty: true,
        thought: '',
        message: '',
      };
      this.activities.set(sessionId, activity);
    }
    return activity;
  }

  private set(activity: Activity, thumbnail: AgentThumbnailEventData): void {
    activity.thumbnail = thumbnail;
    activity.dirty = true;
  }

  private observe(event: FaklEvent): void {
    switch (event.topic) {
      case 'run.limit':
        this.limits.add(event.subject);
        return;
      case 'run.done':
        this.limits.delete(event.subject);
        return;
      case 'agent.state': {
        const data = event.data as AgentStateEventData;
        const activity = this.activity(event.subject);
        if (data.state === 'pensando') activity.thought = '';
        if (data.state === 'ocioso' || data.state === 'concluído' || data.state === 'parado') {
          this.set(activity, {
            tipo: 'ocioso',
            titulo: data.state,
            linhas: tail(activity.message, 3),
          });
        }
        if (data.state === 'falhou') {
          this.set(activity, {
            tipo: 'resposta',
            titulo: 'falhou',
            linhas: data.reason ? [cut(data.reason)] : [],
          });
        }
        return;
      }
      case 'agent.output': {
        const data = event.data as AgentOutputEventData;
        const activity = this.activity(event.subject);
        if (data.kind === 'thought') {
          activity.thought = (activity.thought + data.text).slice(-600);
          this.set(activity, {
            tipo: 'pensando',
            titulo: 'pensando',
            linhas: tail(activity.thought),
          });
        } else if (data.kind === 'message') {
          activity.message = (activity.message + data.text).slice(-600);
          this.set(activity, {
            tipo: 'resposta',
            titulo: 'respondendo',
            linhas: tail(activity.message),
          });
        }
        return;
      }
      case 'agent.tool': {
        const data = event.data as AgentToolEventData;
        const title = data.title ?? data.kind ?? 'ferramenta';
        const activity = this.activity(event.subject);
        if (data.kind === 'execute' || TEST_COMMAND.test(title)) {
          const tests = TEST_COMMAND.test(title);
          const resultado =
            data.status === 'completed' ? 'ok' : data.status === 'failed' ? 'falhou' : 'rodando';
          this.set(activity, {
            tipo: tests ? 'testes' : 'comando',
            titulo: cut(title),
            linhas: [`$ ${cut(title)}`],
            ...(tests ? { resultado } : {}),
          });
        } else if (data.kind === 'edit') {
          this.set(activity, { tipo: 'arquivo', titulo: cut(title), linhas: [] });
        }
        return;
      }
      case 'agent.file': {
        const path = (event.data as { path?: string }).path;
        if (!path) return;
        const activity = this.activity(event.subject);
        activity.pendingFile = path;
        this.set(activity, {
          tipo: 'arquivo',
          titulo: cut(path),
          linhas: activity.thumbnail.linhas,
        });
        return;
      }
      default:
        return;
    }
  }

  /** Publica as miniaturas que mudaram; lê o diff dos arquivos editados. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [sessionId, activity] of this.activities) {
        const state = this.options.agents.stateOf(sessionId);
        if (state === undefined) {
          this.activities.delete(sessionId);
          continue;
        }
        const file = activity.pendingFile;
        if (file) {
          delete activity.pendingFile;
          const cwd = this.options.agents.cwdOf(sessionId);
          if (cwd) {
            const lines = await (this.options.diffLines ?? gitDiffLines)(cwd, file).catch(() => []);
            this.set(activity, { tipo: 'arquivo', titulo: cut(file), linhas: lines });
          }
        }
        if (!activity.dirty) continue;
        activity.dirty = false;
        this.options.bus.publish<AgentThumbnailEventData>(
          'agent.thumbnail',
          sessionId,
          activity.thumbnail,
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  private start(): void {
    if (this.timer) return;
    for (const activity of this.activities.values()) activity.dirty = true;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 2_000);
    this.timer.unref();
    void this.tick();
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  state(): CafeState {
    const { agents, orchestrator, costs } = this.options;
    const list: CafeAgent[] = agents
      .list()
      // Sessões só guardadas no disco (sem agente rodando) não ficam no café.
      .filter(
        (session) => !session.retomavel || agents.sessionProfile(session.sessionId) !== undefined,
      )
      .map((session) => {
        const role = orchestrator.agentInRun(session.sessionId);
        const profile = agents.sessionProfile(session.sessionId)?.profile;
        const thumbnail = this.activities.get(session.sessionId)?.thumbnail;
        return {
          sessionId: session.sessionId,
          nome: session.nome,
          profileId: session.profileId,
          provedor: profile?.provedor ?? 'outro',
          state: session.state,
          ...(role
            ? {
                papel: role.papel,
                runId: role.runId,
                ...(role.parentSessionId ? { parentSessionId: role.parentSessionId } : {}),
              }
            : {}),
          ...(thumbnail ? { miniatura: thumbnail } : {}),
        };
      });
    const today = localDay(this.clock());
    const runs = orchestrator.runList();
    const endedToday = runs.filter((r) => r.fim && localDay(new Date(r.fim)) === today);
    const startedToday = runs.filter((r) => localDay(new Date(r.inicio)) === today);
    const ci = this.options.ci?.();
    return {
      agentes: list,
      placar: {
        dia: today,
        tarefas: endedToday.filter((r) => r.status === 'concluída').length,
        prs: endedToday.filter((r) => r.prUrl).length,
        custoUsd: costs.summary(today).total.custoUsd,
        maxAgentes: Math.max(0, ...startedToday.map((r) => r.agentes.length)),
        prsTotal: runs.filter((r) => r.prUrl).length,
      },
      limites: [...this.limits],
      ...(ci ? { ci } : {}),
    };
  }

  register(router: Router): void {
    router.register('cafe.open', (_params, context: CallContext) => {
      const id = context.connectionId;
      if (!this.viewers.has(id)) {
        this.viewers.add(id);
        context.onClose(() => {
          this.viewers.delete(id);
          if (this.viewers.size === 0) this.stop();
        });
      }
      this.start();
      return this.state();
    });
    router.register('cafe.close', (_params, context) => {
      this.viewers.delete(context.connectionId);
      if (this.viewers.size === 0) this.stop();
      return null;
    });
    router.register('cafe.state', () => this.state());
  }
}
