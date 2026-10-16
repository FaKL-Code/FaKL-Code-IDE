import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProfile } from '@fakl/agents';
import type { Run, Task } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntime } from '../src/agents.js';
import type { CostTracker } from '../src/costs.js';
import { EventBus } from '../src/events/bus.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { Router, type CallContext } from '../src/rpc/router.js';
import { waitFor } from './helpers.js';

const context: CallContext = {
  connectionId: 'test',
  notify: () => undefined,
  onClose: () => undefined,
};
const recovery = {
  motivo: 'limite-sessao' as const,
  mensagem: "You've hit your limit · resets 5pm (America/Sao_Paulo)",
  retomarEm: '2026-10-15T20:00:00.000Z',
  automatica: false,
};

describe('orquestrador: continuidade depois de limite de sessão', () => {
  let dir: string;
  let orchestrator: Orchestrator;
  let router: Router;
  let bus: EventBus;
  let blocked = true;
  const profile: AgentProfile = {
    id: 'claude',
    nome: 'Claude',
    provedor: 'anthropic',
    adaptador: 'acp',
    podeSerMaestro: true,
  };
  const resume = vi.fn();
  const setAutoResume = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-recovery-'));
    bus = new EventBus();
    router = new Router();
    blocked = true;
    resume.mockReset();
    setAutoResume.mockReset();
    await mkdir(join(dir, 'tasks'));
    await mkdir(join(dir, 'runs'));
    const task: Task = {
      id: 'task',
      titulo: 'Continuar trabalho',
      repoPath: dir,
      origem: 'manual',
      status: 'pausada',
      criadaEm: '2026-10-15T10:00:00.000Z',
      runs: ['run'],
    };
    const run: Run = {
      id: 'run',
      taskId: task.id,
      status: 'pausada',
      inicio: task.criadaEm,
      branch: 'fakl/task/maestro',
      maestroSessionId: 'maestro',
      agentes: [
        {
          sessionId: 'maestro',
          profileId: profile.id,
          papel: 'maestro',
          profundidade: 0,
          branch: 'fakl/task/maestro',
        },
      ],
      rodadas: [],
      decisoes: [],
    };
    await writeFile(join(dir, 'tasks', 'task.json'), JSON.stringify(task));
    await writeFile(join(dir, 'runs', 'run.json'), JSON.stringify(run));
    const agents = {
      list: () => [
        {
          sessionId: 'maestro',
          state: 'pausado',
          taskId: 'task',
          retomada: blocked ? recovery : undefined,
        },
      ],
      stateOf: () => 'pausado',
      recoveryOf: () => (blocked ? recovery : undefined),
      resume,
      pause: vi.fn(),
      setAutoResume,
    } as unknown as AgentRuntime;
    const costs = {
      sessionTotals: () => ({ tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 }),
    } as unknown as CostTracker;
    orchestrator = new Orchestrator({
      bus,
      agents,
      costs,
      profiles: () => [profile],
      dataDir: dir,
    });
    orchestrator.register(router);
    await orchestrator.load();
  });

  afterEach(async () => {
    orchestrator.dispose();
    await orchestrator.settle();
    await rm(dir, { recursive: true, force: true });
  });

  const getRun = (): Promise<Run> =>
    router.dispatch('runs.get', { runId: 'run' }, context) as Promise<Run>;

  it('associa sessões restauradas à execução e guarda o bloqueio sem finalizar', async () => {
    bus.publish('agent.recovery', 'maestro', { retomada: recovery });
    const run = await getRun();
    expect(run).toMatchObject({
      status: 'pausada',
      branch: 'fakl/task/maestro',
      retomada: { sessionId: 'maestro', ...recovery },
    });
    expect(bus.replay(['run.done'])).toHaveLength(0);
    await waitFor(() => bus.replay(['run.agents']).length > 0);
  });

  it('retoma o mesmo maestro e o mesmo branch, sem criar outra execução', async () => {
    bus.publish('agent.recovery', 'maestro', { retomada: recovery });
    resume.mockImplementation(() => {
      blocked = false;
      bus.publish('agent.recovery', 'maestro', { retomada: null });
      return Promise.resolve();
    });
    await router.dispatch('runs.resume', { runId: 'run' }, context);
    expect(resume).toHaveBeenCalledWith('maestro');
    expect(await getRun()).toMatchObject({
      status: 'executando',
      maestroSessionId: 'maestro',
      branch: 'fakl/task/maestro',
    });
    expect((await getRun()).agentes).toHaveLength(1);
    expect((await getRun()).retomada).toBeUndefined();
  });

  it('mantém a execução pausada quando a retomada falha', async () => {
    bus.publish('agent.recovery', 'maestro', { retomada: recovery });
    resume.mockRejectedValue(new Error('login necessário'));
    await expect(router.dispatch('runs.resume', { runId: 'run' }, context)).rejects.toThrow(
      'login necessário',
    );
    expect((await getRun()).status).toBe('pausada');
  });

  it('permite escolher retomada automática na sessão bloqueada', async () => {
    bus.publish('agent.recovery', 'maestro', { retomada: recovery });
    await router.dispatch('runs.setAutoResume', { runId: 'run', automatica: true }, context);
    expect(setAutoResume).toHaveBeenCalledWith('maestro', true);
  });

  it('uma pausa explícita desliga a retomada automática', async () => {
    bus.publish('agent.recovery', 'maestro', { retomada: recovery });
    await router.dispatch('runs.pause', { runId: 'run' }, context);
    expect(setAutoResume).toHaveBeenCalledWith('maestro', false);
  });

  it('retoma falha antiga guardada no branch usando a sessão preservada', async () => {
    Object.assign(await getRun(), { status: 'falhou', resultado: 'branch' });
    blocked = false;
    resume.mockResolvedValue(undefined);
    await router.dispatch('runs.resume', { runId: 'run' }, context);
    expect(resume).toHaveBeenCalledWith('maestro');
    expect(await getRun()).toMatchObject({ status: 'executando', branch: 'fakl/task/maestro' });
  });

  it('duas retomadas simultâneas compartilham uma única tentativa', async () => {
    bus.publish('agent.recovery', 'maestro', { retomada: recovery });
    let release: (() => void) | undefined;
    resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = router.dispatch('runs.resume', { runId: 'run' }, context);
    const second = router.dispatch('runs.resume', { runId: 'run' }, context);
    expect(resume).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
  });

  it('o desligamento espera a persistência do bloqueio', async () => {
    bus.publish('agent.recovery', 'maestro', { retomada: recovery });
    await orchestrator.settle();
    const { readFile } = await import('node:fs/promises');
    const saved = JSON.parse(await readFile(join(dir, 'runs', 'run.json'), 'utf8')) as Run;
    expect(saved.retomada).toMatchObject({ sessionId: 'maestro' });
  });

  it('restaura as ferramentas do maestro sem converter a tarefa em conversa', () => {
    expect(orchestrator.sessionMcp('maestro', profile)).toEqual([]);
    expect(orchestrator.sessionMcp('desconhecida', profile)).toBeUndefined();
  });
});
