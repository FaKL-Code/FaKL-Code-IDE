import type { CiRun } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  changedRuns,
  ciState,
  failingCount,
  greenStreak,
  INTERVAL,
  limitRepos,
  MAX_WATCHED_REPOS,
  nextDelayMs,
  parseWatchedRepo,
  toCiRun,
} from '../src/ci-model.js';

function run(id: number, estado: CiRun['estado'], at: number, extra: Partial<CiRun> = {}): CiRun {
  return {
    repo: 'acme/app',
    id,
    numero: id,
    nome: 'build',
    branch: 'main',
    evento: 'push',
    estado,
    url: `https://github.com/acme/app/actions/runs/${String(id)}`,
    inicio: new Date(2026, 9, 18, 12, at).toISOString(),
    jobs: [],
    ...extra,
  };
}

describe('estado de uma execução do GitHub', () => {
  it('traduz status e conclusão', () => {
    expect(ciState('in_progress', null)).toBe('trabalhando');
    expect(ciState('queued', null)).toBe('fila');
    expect(ciState('pending', null)).toBe('fila');
    expect(ciState('waiting', null)).toBe('aguardando');
    expect(ciState('completed', 'success')).toBe('sucesso');
    expect(ciState('completed', 'neutral')).toBe('sucesso');
    expect(ciState('completed', 'failure')).toBe('falha');
    expect(ciState('completed', 'timed_out')).toBe('falha');
    expect(ciState('completed', 'startup_failure')).toBe('falha');
    expect(ciState('completed', 'cancelled')).toBe('cancelada');
    expect(ciState('completed', 'skipped')).toBe('cancelada');
    expect(ciState('completed', 'action_required')).toBe('aguardando');
    expect(ciState(null, null)).toBe('fila');
  });

  it('monta a execução com os jobs e sem fim enquanto roda', () => {
    const base = {
      id: 7,
      name: 'ci',
      head_branch: 'feat/x',
      event: 'pull_request',
      html_url: 'https://github.com/acme/app/actions/runs/7',
      run_number: 12,
      created_at: '2026-10-18T12:00:00Z',
      updated_at: '2026-10-18T12:01:00Z',
    };
    const running = toCiRun('acme/app', { ...base, status: 'in_progress', conclusion: null }, [
      { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
    ]);
    expect(running.estado).toBe('trabalhando');
    expect(running.fim).toBeUndefined();
    expect(running.jobs).toEqual([{ id: 1, nome: 'lint', estado: 'sucesso' }]);
    const done = toCiRun('acme/app', { ...base, status: 'completed', conclusion: 'failure' });
    expect(done.estado).toBe('falha');
    expect(done.fim).toBe('2026-10-18T12:01:00Z');
    expect(done.nome).toBe('ci');
    expect(done.branch).toBe('feat/x');
  });
});

describe('intervalo adaptativo', () => {
  const now = 1_000_000;

  it('é rápido com execução ativa, médio logo após mudar e lento ocioso', () => {
    expect(nextDelayMs({ active: true, sinceChangeMs: 0, failures: 0, now })).toBe(INTERVAL.active);
    expect(nextDelayMs({ active: false, sinceChangeMs: 10_000, failures: 0, now })).toBe(
      INTERVAL.settling,
    );
    expect(nextDelayMs({ active: false, sinceChangeMs: undefined, failures: 0, now })).toBe(
      INTERVAL.idle,
    );
    expect(nextDelayMs({ active: false, sinceChangeMs: 10 * 60_000, failures: 0, now })).toBe(
      INTERVAL.idle,
    );
  });

  it('dobra a cada falha seguida, com teto', () => {
    expect(nextDelayMs({ active: true, sinceChangeMs: 0, failures: 1, now })).toBe(
      INTERVAL.active * 2,
    );
    expect(nextDelayMs({ active: true, sinceChangeMs: 0, failures: 2, now })).toBe(
      INTERVAL.active * 4,
    );
    expect(nextDelayMs({ active: false, sinceChangeMs: undefined, failures: 9, now })).toBe(
      INTERVAL.maxBackoff,
    );
  });

  it('nunca consulta antes de o limite da API voltar', () => {
    const wait = nextDelayMs({
      active: true,
      sinceChangeMs: 0,
      failures: 0,
      limitedUntil: now + 600_000,
      now,
    });
    expect(wait).toBeGreaterThanOrEqual(600_000);
    // Limite que já voltou não pesa.
    expect(
      nextDelayMs({ active: true, sinceChangeMs: 0, failures: 0, limitedUntil: now - 1, now }),
    ).toBe(INTERVAL.active);
  });
});

describe('limite de repositórios', () => {
  it('põe os abertos antes dos marcados e tira repetidos sem olhar maiúsculas', () => {
    const { watched, descartados } = limitRepos(['acme/app'], ['Acme/App', 'acme/lib']);
    expect(watched).toEqual([
      { repo: 'acme/app', origem: 'aberto' },
      { repo: 'acme/lib', origem: 'marcado' },
    ]);
    expect(descartados).toEqual([]);
  });

  it('corta no limite e devolve o que sobrou', () => {
    const marked = Array.from({ length: 8 }, (_, i) => `acme/r${String(i)}`);
    const { watched, descartados } = limitRepos(['acme/open'], marked);
    expect(watched).toHaveLength(MAX_WATCHED_REPOS);
    expect(watched[0]?.repo).toBe('acme/open');
    expect(descartados).toEqual(['acme/r4', 'acme/r5', 'acme/r6', 'acme/r7']);
  });

  it('só aceita dono/nome', () => {
    expect(parseWatchedRepo(' acme/app ')).toBe('acme/app');
    expect(parseWatchedRepo('acme')).toBeUndefined();
    expect(parseWatchedRepo('acme/app/extra')).toBeUndefined();
    expect(parseWatchedRepo('-acme/app')).toBeUndefined();
    expect(parseWatchedRepo(42)).toBeUndefined();
  });
});

describe('deduplicação de eventos', () => {
  it('só devolve o que mudou e esquece o que saiu da janela', () => {
    const seen = new Map<string, string>();
    const a = run(1, 'trabalhando', 0);
    expect(changedRuns(seen, [a])).toEqual([a]);
    expect(changedRuns(seen, [a])).toEqual([]);
    const finished = run(1, 'sucesso', 0);
    expect(changedRuns(seen, [finished])).toEqual([finished]);
    // Mudou só um job: também conta.
    const withJob = { ...finished, jobs: [{ id: 5, nome: 'test', estado: 'falha' as const }] };
    expect(changedRuns(seen, [withJob])).toEqual([withJob]);
    expect(changedRuns(seen, [])).toEqual([]);
    expect(seen.size).toBe(0);
  });
});

describe('placar do CI', () => {
  it('conta builds verdes seguidos, ignorando canceladas e execuções em andamento', () => {
    const runs = [
      run(1, 'falha', 0),
      run(2, 'sucesso', 1),
      run(3, 'cancelada', 2),
      run(4, 'sucesso', 3),
      run(5, 'trabalhando', 4),
    ];
    expect(greenStreak(runs)).toBe(2);
    expect(greenStreak([run(1, 'falha', 0)])).toBe(0);
    expect(greenStreak([])).toBe(0);
  });

  it('conta fluxos falhando e apaga a falha quando uma execução seguinte passa', () => {
    expect(failingCount([run(1, 'falha', 0)])).toBe(1);
    expect(failingCount([run(1, 'falha', 0), run(2, 'sucesso', 1)])).toBe(0);
    // Em andamento ou cancelada não apaga a falha anterior.
    expect(failingCount([run(1, 'falha', 0), run(2, 'trabalhando', 1)])).toBe(1);
    expect(failingCount([run(1, 'falha', 0), run(2, 'cancelada', 1)])).toBe(1);
    // Outro branch é outro fluxo.
    expect(failingCount([run(1, 'falha', 0), run(2, 'falha', 1, { branch: 'feat/x' })])).toBe(2);
  });
});
