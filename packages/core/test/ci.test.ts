import type { GhJob, GhRepoRef, GhWorkflowRun } from '@fakl/integrations';
import type { CiRun, CiStatus, FaklEvent } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { CiService, EventBus, Router, type CallContext, type CiSource } from '../src/index.js';

function ghRun(
  id: number,
  status: string,
  conclusion: string | null,
  minute: number,
): GhWorkflowRun {
  return {
    id,
    name: 'build',
    head_branch: 'main',
    head_sha: 'abc',
    event: 'push',
    status,
    conclusion,
    html_url: `https://github.com/acme/app/actions/runs/${String(id)}`,
    run_number: id,
    created_at: new Date(Date.UTC(2026, 9, 18, 12, minute)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 9, 18, 12, minute, 30)).toISOString(),
  };
}

function ghJob(id: number, status: string, conclusion: string | null): GhJob {
  return { id, name: `job-${String(id)}`, status, conclusion, html_url: null };
}

/** Cliente do GitHub falso: devolve o que o teste pôs e anota as chamadas. */
class FakeGitHub implements CiSource {
  connected = true;
  limit: number | undefined;
  runsByRepo = new Map<string, GhWorkflowRun[]>();
  jobsByRun = new Map<number, GhJob[]>();
  failing = new Set<string>();
  runCalls: string[] = [];
  jobCalls: number[] = [];
  folders = new Map<string, GhRepoRef>();

  runs(repo: GhRepoRef): Promise<readonly GhWorkflowRun[]> {
    const name = `${repo.owner}/${repo.name}`;
    this.runCalls.push(name);
    if (this.failing.has(name)) return Promise.reject(new Error('GitHub 500'));
    return Promise.resolve(this.runsByRepo.get(name) ?? []);
  }

  jobs(_repo: GhRepoRef, runId: number): Promise<readonly GhJob[]> {
    this.jobCalls.push(runId);
    return Promise.resolve(this.jobsByRun.get(runId) ?? []);
  }

  repoOf(path: string): Promise<GhRepoRef | undefined> {
    return Promise.resolve(this.folders.get(path));
  }

  limitedUntil(): number | undefined {
    return this.limit;
  }
}

function setup() {
  const bus = new EventBus();
  const events: FaklEvent[] = [];
  bus.subscribe(['ci.run'], (event) => events.push(event));
  const source = new FakeGitHub();
  const scheduled: { ms: number; run: () => void; cancelled: boolean }[] = [];
  let now = Date.UTC(2026, 9, 18, 13, 0);
  const ci = new CiService({
    bus,
    source,
    now: () => now,
    schedule: (run, ms) => {
      const entry = { ms, run, cancelled: false };
      scheduled.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
  });
  const pending = () => scheduled.filter((s) => !s.cancelled);
  return {
    ci,
    source,
    events,
    pending,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const context = {} as CallContext;

describe('serviço do café do CI', () => {
  it('lê as execuções, junta os jobs e publica ci.run uma vez por mudança', async () => {
    const { ci, source, events } = setup();
    source.runsByRepo.set('acme/app', [
      ghRun(1, 'completed', 'success', 0),
      ghRun(2, 'in_progress', null, 5),
    ]);
    source.jobsByRun.set(2, [ghJob(10, 'completed', 'success'), ghJob(11, 'in_progress', null)]);
    await ci.setWatch({ repos: ['acme/app'], automatico: false });
    await ci.refresh();
    const status = ci.status();
    expect(status.conectado).toBe(true);
    expect(status.repos).toHaveLength(1);
    const runs = status.repos[0]?.runs ?? [];
    expect(runs.map((r) => [r.id, r.estado])).toEqual([
      [2, 'trabalhando'],
      [1, 'sucesso'],
    ]);
    expect(runs[0]?.jobs.map((j) => j.estado)).toEqual(['sucesso', 'trabalhando']);
    expect(status.trabalhando).toBe(1);
    expect(status.verdesSeguidos).toBe(1);
    expect(events.map((e) => e.topic)).toEqual(['ci.run', 'ci.run']);
    expect(events.map((e) => e.subject).sort()).toEqual(['acme/app#1', 'acme/app#2']);

    // Nada mudou: sem eventos novos.
    await ci.poll();
    expect(events).toHaveLength(2);

    // A execução terminou com falha: um evento.
    source.runsByRepo.set('acme/app', [
      ghRun(1, 'completed', 'success', 0),
      ghRun(2, 'completed', 'failure', 5),
    ]);
    source.jobsByRun.set(2, [ghJob(10, 'completed', 'success'), ghJob(11, 'completed', 'failure')]);
    await ci.poll();
    expect(events).toHaveLength(3);
    expect((events[2]?.data as CiRun).estado).toBe('falha');
    expect(ci.status().falhando).toBe(1);
    expect(ci.status().verdesSeguidos).toBe(0);
  });

  it('não relê os jobs de uma execução terminada', async () => {
    const { ci, source } = setup();
    source.runsByRepo.set('acme/app', [ghRun(1, 'completed', 'success', 0)]);
    source.jobsByRun.set(1, [ghJob(10, 'completed', 'success')]);
    await ci.setWatch({ repos: ['acme/app'], automatico: false });
    await ci.poll();
    await ci.poll();
    expect(source.jobCalls).toEqual([1]);
  });

  it('só consulta com a conta conectada, mesmo por pedido', async () => {
    const { ci, source } = setup();
    source.connected = false;
    source.folders.set('/work/app', { owner: 'acme', name: 'app' });
    await ci.setWatch({ repos: ['acme/app'], pastas: ['/work/app'] });
    await ci.refresh();
    expect(source.runCalls).toEqual([]);
    expect(ci.status().conectado).toBe(false);
  });

  it('respeita o interruptor: sem consulta automática, só por pedido', async () => {
    const { ci, source, pending } = setup();
    source.runsByRepo.set('acme/app', [ghRun(1, 'completed', 'success', 0)]);
    await ci.setWatch({ repos: ['acme/app'], automatico: false });
    expect(pending()).toHaveLength(0);
    expect(source.runCalls).toEqual([]);
    await ci.refresh();
    expect(source.runCalls).toEqual(['acme/app']);
    // Terminou e continua sem agendar nada.
    expect(pending()).toHaveLength(0);
    expect(ci.status().automatico).toBe(false);
  });

  it('com o interruptor ligado agenda a consulta e adapta o intervalo ao que acontece', async () => {
    const { ci, source, pending, advance } = setup();
    source.runsByRepo.set('acme/app', [ghRun(2, 'in_progress', null, 5)]);
    await ci.setWatch({ repos: ['acme/app'], automatico: true });
    // A primeira consulta é logo.
    expect(pending().map((s) => s.ms)).toEqual([0]);
    await ci.poll();
    expect(pending().at(-1)?.ms).toBe(15_000);

    source.runsByRepo.set('acme/app', [ghRun(2, 'completed', 'success', 5)]);
    advance(15_000);
    await ci.poll();
    expect(pending().at(-1)?.ms).toBe(45_000);

    advance(10 * 60_000);
    await ci.poll();
    expect(pending().at(-1)?.ms).toBe(300_000);
  });

  it('recua depois de erros e espera o limite da API voltar', async () => {
    const { ci, source, pending } = setup();
    source.failing.add('acme/app');
    await ci.setWatch({ repos: ['acme/app'], automatico: true });
    await ci.poll();
    expect(pending().at(-1)?.ms).toBe(600_000);
    expect(ci.status().repos[0]?.erro).toBe('GitHub 500');
    source.failing.clear();
    source.limit = Date.UTC(2026, 9, 18, 14, 0);
    source.runsByRepo.set('acme/app', [ghRun(2, 'in_progress', null, 5)]);
    await ci.poll();
    expect(pending().at(-1)?.ms).toBeGreaterThanOrEqual(3_600_000);
  });

  it('acompanha a pasta aberta antes dos marcados e respeita o limite', async () => {
    const { ci, source } = setup();
    source.folders.set('/work/app', { owner: 'acme', name: 'app' });
    const marked = ['acme/a', 'acme/b', 'acme/c', 'acme/d', 'acme/e'];
    const status = await ci.setWatch({
      repos: marked,
      pastas: ['/work/app', '/nada'],
      automatico: false,
    });
    expect(status.repos.map((r) => [r.repo, r.origem])).toEqual([
      ['acme/app', 'aberto'],
      ['acme/a', 'marcado'],
      ['acme/b', 'marcado'],
      ['acme/c', 'marcado'],
      ['acme/d', 'marcado'],
    ]);
    expect(status.descartados).toEqual(['acme/e']);
    await ci.refresh();
    expect([...source.runCalls].sort()).toEqual([
      'acme/a',
      'acme/app',
      'acme/b',
      'acme/c',
      'acme/d',
    ]);
  });

  it('descarta o retrato de quem deixou de ser acompanhado', async () => {
    const { ci, source } = setup();
    source.runsByRepo.set('acme/app', [ghRun(1, 'completed', 'success', 0)]);
    await ci.setWatch({ repos: ['acme/app'], automatico: false });
    await ci.refresh();
    expect(ci.active).toBe(true);
    await ci.setWatch({ repos: [], automatico: false });
    expect(ci.active).toBe(false);
    expect(ci.status().repos).toEqual([]);
  });

  it('atende os métodos ci.status e ci.watch.set', async () => {
    const { ci, source } = setup();
    source.runsByRepo.set('acme/app', [ghRun(1, 'completed', 'failure', 0)]);
    const router = new Router();
    ci.register(router);
    expect(router.has('ci.watch.set')).toBe(true);
    const call = (method: string, params: unknown): Promise<unknown> =>
      router.dispatch(method, params, context);
    const first = (await call('ci.watch.set', {
      repos: ['acme/app'],
      automatico: false,
    })) as CiStatus;
    expect(first.repos).toHaveLength(1);
    const status = (await call('ci.status', { atualizar: true })) as CiStatus;
    expect(status.falhando).toBe(1);
    // Sem `atualizar`, não consulta de novo.
    const calls = source.runCalls.length;
    await call('ci.status', undefined);
    expect(source.runCalls).toHaveLength(calls);
  });
});
