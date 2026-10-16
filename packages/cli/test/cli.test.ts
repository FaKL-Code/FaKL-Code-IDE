import { resolve } from 'node:path';

import { useLocale } from '@fakl/i18n';
import type { CoreMethod } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, usage, type CoreApi } from '../src/cli.js';

function fake(responses: Partial<Record<CoreMethod, unknown>>) {
  const calls: [CoreMethod, unknown][] = [];
  const api: CoreApi = {
    request: <T>(method: CoreMethod, params?: unknown): Promise<T> => {
      calls.push([method, params]);
      return Promise.resolve(responses[method] as T);
    },
  };
  return { calls, core: () => Promise.resolve(api) };
}

async function cli(argv: string[], responses: Partial<Record<CoreMethod, unknown>> = {}) {
  const lines: string[] = [];
  const { calls, core } = fake(responses);
  const code = await runCli(argv, core, { out: (l) => lines.push(l), cwd: '/repo' });
  return { code, out: lines.join('\n'), calls };
}

describe('CLI fakl', () => {
  it('mostra o uso sem comando', async () => {
    const result = await cli([]);
    expect(result.code).toBe(1);
    expect(result.out).toBe(usage());
    expect(result.out).toContain('fakl tarefa criar <title> [options]');
  });

  describe('em português', () => {
    afterEach(() => {
      useLocale('en');
    });

    it('mostra ajuda e mensagens em pt-BR', async () => {
      useLocale('pt-BR');
      const help = await cli([]);
      expect(help.out).toContain('fakl: controla o FaKL Core pela linha de comando.');
      expect(help.out).toContain('fakl tarefa criar <título> [opções]');
      const started = await cli(['executar', 't1'], { 'runs.start': { id: 'r1' } });
      expect(started.out).toBe('Execução r1 começou.');
      const status = await cli(['status'], {
        'agents.list': [],
        'runs.decisions': [],
        'agents.permissions': [],
      });
      expect(status.out).toBe(
        'Core no ar. 0 sessão(ões) de agente, 0 decisão(ões) e 0 permissão(ões) pendente(s).',
      );
      await expect(cli(['maestro', 'x', '--rodadas', '0'])).rejects.toThrow(
        '--rodadas deve ser um número maior que zero',
      );
    });
  });

  it('cria tarefa com origem cli e começa', async () => {
    const result = await cli(
      [
        'tarefa',
        'criar',
        'Adicionar',
        'CSV',
        '--criterio',
        'pnpm lint; pnpm test',
        '--entrega',
        'pr',
        '--comecar',
      ],
      {
        'tasks.create': { id: 't1', titulo: 'Adicionar CSV' },
        'runs.start': { id: 'r1' },
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls[0]).toEqual([
      'tasks.create',
      {
        titulo: 'Adicionar CSV',
        origem: 'cli',
        repoPath: resolve('/repo'),
        entrega: 'pr',
        criterio: { comandos: ['pnpm lint', 'pnpm test'] },
      },
    ]);
    expect(result.calls[1]).toEqual(['runs.start', { taskId: 't1' }]);
    expect(result.out).toContain('Run r1 started.');
  });

  it('lista e responde decisões', async () => {
    const decisions = await cli(['decisoes'], {
      'runs.decisions': [
        {
          id: 'd1',
          runId: 'r1',
          pergunta: 'Limite?',
          opcoes: [{ id: 'aumentar', rotulo: 'Aumentar' }],
        },
      ],
      'agents.permissions': [{ sessionId: 's1', id: 'p1', title: 'Escrever a.txt', options: [] }],
    });
    expect(decisions.out).toContain('aumentar: Aumentar');
    expect(decisions.out).toContain('fakl permitir s1 p1');
    const allowed = await cli(['permitir', 's1', 'p1']);
    expect(allowed.calls[0]).toEqual([
      'agents.permission',
      { sessionId: 's1', id: 'p1', allow: true },
    ]);
    const denied = await cli(['negar', 's1', 'p1']);
    expect(denied.calls[0]).toEqual([
      'agents.permission',
      { sessionId: 's1', id: 'p1', allow: false },
    ]);
    const mode = await cli(['modo', 's1', 'autopilot']);
    expect(mode.calls[0]).toEqual([
      'agents.setPermissions',
      { sessionId: 's1', permissions: 'autopilot' },
    ]);
    const option = await cli(['opcao', 's1', 'model', 'forte']);
    expect(option.calls[0]).toEqual([
      'agents.setOption',
      { sessionId: 's1', id: 'model', value: 'forte' },
    ]);
    const options = await cli(['opcoes', 's1'], {
      'agents.list': [
        {
          sessionId: 's1',
          opcoes: [{ id: 'model', nome: 'Modelo', atual: 'forte', valores: [{ id: 'forte' }] }],
        },
      ],
    });
    expect(options.out).toContain('model  Modelo: forte  (forte)');
    const decided = await cli(['decidir', 'r1', 'd1', 'aumentar']);
    expect(decided.calls[0]).toEqual([
      'runs.decide',
      { runId: 'r1', decisionId: 'd1', escolha: 'aumentar', origem: 'cli' },
    ]);
  });

  it('imprime JSON com --json', async () => {
    const result = await cli(['tarefas', '--json'], { 'tasks.list': [{ id: 't1' }] });
    expect(JSON.parse(result.out)).toEqual([{ id: 't1' }]);
  });

  it('recusa comando desconhecido', async () => {
    expect((await cli(['voar'])).code).toBe(1);
  });
});

describe('git-credential', () => {
  it('entrega o login da IDE para github.com e nada para outros hosts', async () => {
    const calls: unknown[] = [];
    const api: CoreApi = {
      request: <T>(_method: string, params?: unknown) => {
        calls.push(params);
        const host = (params as { host: string }).host;
        return Promise.resolve(
          (host === 'github.com' ? { username: 'x-access-token', password: 't0k' } : null) as T,
        );
      },
    };
    const lines: string[] = [];
    const io = {
      out: (line: string) => lines.push(line),
      cwd: '/',
      stdin: () => Promise.resolve('protocol=https\nhost=github.com\n\n'),
    };
    expect(await runCli(['git-credential', 'get'], () => Promise.resolve(api), io)).toBe(0);
    expect(lines).toEqual(['username=x-access-token\npassword=t0k']);
    lines.length = 0;
    await runCli(['git-credential', 'get'], () => Promise.resolve(api), {
      ...io,
      stdin: () => Promise.resolve('protocol=https\nhost=gitlab.com\n'),
    });
    expect(lines).toEqual([]);
    expect(
      await runCli(['git-credential', 'store'], () => Promise.reject(new Error('x')), io),
    ).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('maestro: vira tarefa com o texto, aprova tudo por padrão e começa', async () => {
    const result = await cli(
      ['maestro', 'Adicionar exportação CSV\ncom testes', '--rodadas', '3', '--entrega', 'pr'],
      {
        'tasks.create': { id: 't1', titulo: 'Adicionar exportação CSV' },
        'runs.start': { id: 'r1', agentes: [{ profileId: 'claude' }] },
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls[0]).toEqual([
      'tasks.create',
      {
        titulo: 'Adicionar exportação CSV',
        descricao: 'Adicionar exportação CSV\ncom testes',
        origem: 'cli',
        repoPath: resolve('/repo'),
        permissoes: 'perguntar',
        entrega: 'pr',
        limites: { rodadas: { valor: 3 } },
      },
    ]);
    expect(result.calls[1]).toEqual(['runs.start', { taskId: 't1' }]);
    expect(result.out).toContain('Run r1 started (maestro claude)');
  });

  it('maestro: exige o texto e valida os limites', async () => {
    expect((await cli(['maestro'])).code).toBe(1);
    await expect(cli(['maestro', 'x', '--rodadas', '0'])).rejects.toThrow(/--rodadas/);
  });

  it('maestro --aguardar: acompanha até o fim e sai com o código do resultado', async () => {
    const statuses = ['executando', 'executando', 'concluída'];
    const lines: string[] = [];
    const api: CoreApi = {
      request: <T>(method: CoreMethod): Promise<T> => {
        if (method === 'tasks.create') return Promise.resolve({ id: 't1' } as T);
        if (method === 'runs.decisions') return Promise.resolve([] as T);
        const status = method === 'runs.get' ? (statuses.shift() ?? 'concluída') : 'executando';
        return Promise.resolve({
          id: 'r1',
          status,
          rodadas: [],
          agentes: [],
          resultado: 'merge',
        } as T);
      },
    };
    const code = await runCli(['maestro', 'faça', '--aguardar'], () => Promise.resolve(api), {
      out: (l) => lines.push(l),
      cwd: '/repo',
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(0);
    expect(lines.at(-1)).toContain('concluída');
  });
});
