import { useLocale } from '@fakl/i18n';
import type { Run } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canOpenMaestro,
  canResumeRun,
  runContext,
  runDescription,
  taskStatusLabel,
} from '../src/tasks-model.js';

const run = (extra: Partial<Run> = {}): Run => ({
  id: 'run-1',
  taskId: 'task-1',
  inicio: '2026-10-15T18:00:00Z',
  status: 'executando',
  branch: 'fakl/tarefa',
  maestroSessionId: 'maestro-1',
  agentes: [],
  rodadas: [],
  decisoes: [],
  ...extra,
});

describe('ações de retomada das tarefas', () => {
  it('permite retomar uma pausa ou uma falha com trabalho conservado no branch', () => {
    expect(canResumeRun(run({ status: 'pausada' }))).toBe(true);
    expect(canResumeRun(run({ status: 'falhou', resultado: 'branch' }))).toBe(true);
    for (const status of ['executando', 'falhou', 'concluída', 'descartada'] as const) {
      expect(canResumeRun(run({ status }))).toBe(false);
    }
  });

  it('mantém o chat do maestro acessível quando pausado ou recuperável', () => {
    expect(canOpenMaestro(run({ status: 'pausada' }))).toBe(true);
    expect(canOpenMaestro(run({ status: 'falhou', resultado: 'branch' }))).toBe(true);
    expect(canOpenMaestro(run({ status: 'falhou' }))).toBe(false);
    expect(canOpenMaestro({ ...run(), maestroSessionId: '' })).toBe(false);
  });

  it('distingue retomada manual e automática nos menus e preserva o menu de PR', () => {
    const retomada: NonNullable<Run['retomada']> = {
      motivo: 'limite-sessao',
      sessionId: 'maestro-1',
      mensagem: 'Limite de sessão.',
      automatica: false,
    };
    const limited = run({
      status: 'pausada',
      retomada,
      prUrl: 'https://github.com/fakl/repo/pull/1',
    });
    expect(runContext(limited)).toBe('fakl.run.pausada.retomavel.limite.pr');
    expect(runContext({ ...limited, retomada: { ...retomada, automatica: true } })).toBe(
      'fakl.run.pausada.retomavel.limite.auto.pr',
    );
    expect(runContext(run({ status: 'falhou', resultado: 'branch' }))).toBe(
      'fakl.run.falhou.retomavel',
    );
    expect(runContext(run())).toBe('fakl.run.executando');
  });
});

describe('textos da árvore de tarefas', () => {
  afterEach(() => useLocale('en'));

  it('descreve a execução com estado, rodadas, agentes e limite', () => {
    const limited = run({
      status: 'pausada',
      resultado: 'rascunho',
      rodadas: [{} as Run['rodadas'][number]],
      retomada: {
        motivo: 'limite-sessao',
        sessionId: 'maestro-1',
        mensagem: 'Limite.',
        automatica: true,
      },
    });
    expect(runDescription(run())).toBe('running · 0 rounds · 0 agents');
    expect(runDescription(limited)).toBe(
      'paused · 1 round · 0 agents · draft · Session limit · Automatic resume',
    );
    expect(taskStatusLabel('concluída')).toBe('done');
  });

  it('mostra os mesmos textos em pt-BR', () => {
    useLocale('pt-br');
    expect(runDescription(run({ status: 'aguardando-decisão', resultado: 'merge' }))).toBe(
      'aguardando-decisão · 0 rodadas · 0 agentes · merge',
    );
    expect(taskStatusLabel('pausada')).toBe('pausado');
  });
});
