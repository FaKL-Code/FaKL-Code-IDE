import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpAdapter } from '@fakl/agents';
import { isFinalAgentState } from '@fakl/protocol';
import type {
  AgentOutputEventData,
  AgentProfileDefinition,
  AgentSessionInfo,
  Decision,
  EventNotificationParams,
  FaklEvent,
  Run,
  Task,
} from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classificarComplexidade,
  CoreClient,
  CoreRpcError,
  createCore,
  createSessionToken,
  deliveryTitle,
  effectiveLimits,
  exceeded,
  McpServer,
  MAESTRO_TOOLS,
  parseLimits,
  scaleLimits,
  type Core,
} from '../src/index.js';
import { testSocket, waitFor } from './helpers.js';

const fixtures = new URL('../../agents/test/fixtures/', import.meta.url);
const fakeAgent = fileURLToPath(new URL('fake-agent.mjs', fixtures));
const fakeMaestro = fileURLToPath(new URL('fake-maestro.mjs', fixtures));
const mcpMain = fileURLToPath(new URL('../dist/mcp/main.js', import.meta.url));

describe('limites', () => {
  it('o mais específico vence e o padrão completa', () => {
    const limits = effectiveLimits(
      { rodadas: { valor: 2 } },
      { rodadas: { valor: 9 }, tokens: { valor: 100 } },
    );
    expect(limits.rodadas).toEqual({ valor: 2 });
    expect(limits.tokens).toEqual({ valor: 100 });
    expect(limits.tempoMin?.valor).toBe(120);
  });

  it('acha o limite estourado e aumenta só ele', () => {
    const limits = { rodadas: { valor: 2 }, custoUsd: { valor: 1, acao: 'rascunho' as const } };
    expect(exceeded(limits, { rodadas: 0, tempoMin: 1, tokens: 0, custoUsd: 1.2 })).toEqual({
      limite: 'custoUsd',
      valor: 1,
      atual: 1.2,
      acao: 'rascunho',
    });
    expect(scaleLimits(limits, 1.5, 'rodadas').rodadas?.valor).toBe(3);
    expect(scaleLimits(limits, 1.5, 'rodadas').custoUsd?.valor).toBe(1);
  });

  it('valida limites de YAML', () => {
    expect(parseLimits({ rodadas: 3, custoUsd: { valor: 2, acao: 'descartar' } }, 'x')).toEqual({
      rodadas: { valor: 3 },
      custoUsd: { valor: 2, acao: 'descartar' },
    });
    expect(() => parseLimits({ rodadas: { valor: 0 } }, 'x')).toThrow(/maior que zero/);
    expect(() => parseLimits({ tokens: { valor: 5, acao: 'fugir' } }, 'x')).toThrow(/acao/);
  });
});

describe('servidor MCP', () => {
  it('fala initialize, tools/list e tools/call', async () => {
    const out: unknown[] = [];
    const server = new McpServer({
      name: 'fakl',
      version: '0',
      tools: MAESTRO_TOOLS,
      call: (method, args) =>
        method === 'maestro.finish'
          ? Promise.reject(new Error('não agora'))
          : Promise.resolve({ method, args }),
      write: (line) => out.push(JSON.parse(line)),
    });
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      }),
    );
    await server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'stop_agent', arguments: { sessionId: 'a' } },
      }),
    );
    await server.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'finish', arguments: {} },
      }),
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26' } });
    const tools = (out[1] as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name,
    );
    expect(tools).toContain('spawn_agent');
    expect(
      JSON.parse(
        (out[2] as { result: { content: { text: string }[] } }).result.content[0]?.text ?? '',
      ),
    ).toEqual({
      method: 'maestro.stopAgent',
      args: { sessionId: 'a' },
    });
    expect(out[3]).toMatchObject({ id: 4, result: { isError: true } });
  });
});

describe.skipIf(!existsSync(mcpMain))('Core: orquestrador', () => {
  let socket: Awaited<ReturnType<typeof testSocket>>;
  let core: Core;
  let client: CoreClient;
  let dir: string;
  let repo: string;
  const events: FaklEvent[] = [];
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  const startCore = async (
    maestroMode = 'completo',
    resumeInterrupted = false,
    fetch?: (url: string, init?: RequestInit) => Promise<Response>,
    perfisAntes: readonly AgentProfileDefinition[] = [],
  ): Promise<void> => {
    socket = await testSocket();
    const token = createSessionToken();
    core = createCore({
      socketPath: socket.path,
      token,
      configHome: join(dir, 'home'),
      mcp: { command: process.execPath, args: [mcpMain] },
      resumeInterrupted,
      ...(fetch ? { fetch } : {}),
      agents: {
        home: join(dir, 'home'),
        profiles: [
          ...perfisAntes,
          {
            id: 'maestro',
            nome: 'Maestro',
            provedor: maestroMode === 'limite-sessao' ? 'anthropic' : 'teste',
            adaptador: 'acp',
            podeSerMaestro: true,
          },
          { id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' },
        ],
        adapterFor: (profile) =>
          profile.id.startsWith('maestro')
            ? new AcpAdapter({
                command: process.execPath,
                args: [fakeMaestro],
                env: { FAKE_MAESTRO: maestroMode },
              })
            : new AcpAdapter({ command: process.execPath, args: [fakeAgent] }),
      },
    });
    await core.start();
    client = await CoreClient.connect(socket.path, token, 'test');
    client.onNotification((_method, params) => {
      events.push((params as EventNotificationParams).event);
    });
    await client.request('events.subscribe', { topics: ['run.*', 'agent.output'] });
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-orq-'));
    repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.name', 'Teste');
    git('config', 'user.email', 'teste@exemplo.com');
    git('config', 'core.autocrlf', 'false');
    await writeFile(join(repo, 'README.md'), 'oi\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicial');
    events.length = 0;
  });

  afterEach(async () => {
    client.close();
    await core.stop();
    await socket.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  const createTask = (extra: Record<string, unknown> = {}): Promise<Task> =>
    client.request<Task>('tasks.create', {
      titulo: 'Criar novo.txt',
      descricao: 'Um arquivo novo',
      repoPath: repo,
      maestroProfileId: 'maestro',
      criterio: { comandos: ['git cat-file -e HEAD:novo.txt'] },
      entrega: 'merge',
      ...extra,
    });

  const waitRun = async (runId: string, done: (run: Run) => boolean): Promise<Run> => {
    let run: Run | undefined;
    await waitFor(() => {
      void client
        .request<Run>('runs.get', { runId })
        .then((r) => (run = r))
        .catch(() => undefined);
      return run !== undefined && done(run);
    }, 30_000).catch((error: unknown) => {
      // Mostra onde a execução parou, em vez de só o tempo esgotado.
      throw new Error(
        `${String(error)}; execução: ${JSON.stringify(run)}; eventos: ${JSON.stringify(events.filter((e) => e.topic !== 'agent.output').map((e) => [e.topic, e.subject.slice(-4), e.data]))}`,
      );
    });
    if (!run) throw new Error('execução não encontrada');
    return run;
  };

  it('limite de sessão preserva a tarefa e retoma o mesmo maestro manualmente', async () => {
    await startCore('limite-sessao');
    const task = await createTask({ entrega: 'branch', criterio: { comandos: [] } });
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const paused = await waitRun(started.id, (run) => run.retomada !== undefined);
    expect(paused.status).toBe('pausada');
    expect(paused.retomada?.automatica).toBe(false);
    await client.request('runs.resume', { runId: started.id });
    const completed = await waitRun(
      started.id,
      (run) => run.status === 'concluída' || run.status === 'falhou',
    );
    expect(completed.status).toBe('concluída');
    expect(completed.branch).toBe(started.branch);
    expect(completed.maestroSessionId).toBe(started.maestroSessionId);
    expect(completed.agentes).toHaveLength(1);
    expect(git('show', completed.branch + ':limite.txt')).toBe('trabalho antes do limite');
    const transcript = await core.agents.transcript(started.maestroSessionId ?? '');
    expect(
      transcript.items.some((item) => item.kind === 'agent' && item.text.includes('retomou')),
    ).toBe(true);
  });

  it('retoma o histórico e ferramentas da tarefa após reiniciar o Core durante o limite', async () => {
    await startCore('limite-sessao');
    const task = await createTask({ entrega: 'branch', criterio: { comandos: [] } });
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    await waitRun(started.id, (run) => run.retomada !== undefined);
    client.close();
    await core.stop();
    await startCore('limite-sessao');
    const before = await client.request<Run>('runs.get', { runId: started.id });
    expect(before.retomada).toBeDefined();
    expect(before.maestroSessionId).toBe(started.maestroSessionId);
    await client.request('runs.resume', { runId: started.id });
    const completed = await waitRun(
      started.id,
      (run) => run.status === 'concluída' || run.status === 'falhou',
    );
    expect(completed.status).toBe('concluída');
    expect(completed.maestroSessionId).toBe(started.maestroSessionId);
    expect(completed.branch).toBe(started.branch);
    expect(git('show', completed.branch + ':limite.txt')).toBe('trabalho antes do limite');
    const transcript = await core.agents.transcript(started.maestroSessionId ?? '');
    expect(
      transcript.items.some((item) => item.kind === 'agent' && item.text.includes('retomou')),
    ).toBe(true);
  });

  it('o maestro delega, integra, verifica e entrega com merge', async () => {
    // Como o commitlint de um projeto: só aceita cabeçalho convencional ou merge do git.
    await writeFile(
      join(repo, '.git', 'hooks', 'commit-msg'),
      '#!/bin/sh\nhead -n 1 "$1" | grep -qE "^(Merge |feat|fix|chore)" || { echo "tipo inválido" >&2; exit 1; }\n',
      { mode: 0o755 },
    );
    await startCore();
    const task = await createTask();
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status === 'concluída' || r.status === 'falhou');

    expect(run.status).toBe('concluída');
    expect(run.resultado).toBe('merge');
    // finish logo depois de run_checks, sem mudança no worktree, não repete a rodada.
    expect(run.rodadas.map((r) => r.veredito)).toEqual(['passou']);
    expect(run.agentes.map((a) => [a.profileId, a.papel, a.profundidade])).toEqual([
      ['maestro', 'maestro', 0],
      ['falso', 'executor', 1],
    ]);
    expect(git('show', 'main:novo.txt')).toBe('um\ndois\ntrês');
    expect(git('log', '-1', '--format=%s%n%b', 'main')).toBe(
      `Merge branch '${run.branch}'\nfakl: Criar novo.txt`,
    );
    // O finish não cancela a vez do maestro: o custo dela chega no fim.
    const maestro = (await client.request<AgentSessionInfo[]>('agents.list')).find(
      (s) => s.sessionId === run.maestroSessionId,
    );
    expect(maestro?.usage.cost).toEqual({ amount: 0.42, currency: 'USD' });

    const log = events
      .filter((e) => e.topic === 'agent.output')
      .map((e) => (e.data as AgentOutputEventData).text)
      .find((text) => text.startsWith('{"tools"'));
    const parsed = JSON.parse(log ?? '{}') as Record<string, unknown>;
    expect(parsed.tools).toContain('finish');
    expect(parsed.profiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'falso', instalado: true })]),
    );
    expect(String((parsed.proibido as { erro?: string }).erro)).toMatch(/não pode ser maestro/);
    expect(parsed.checks).toMatchObject({ numero: 1, veredito: 'passou' });
    // A saída do que passou não volta para o maestro; a rodada gravada fica inteira.
    const checks = (parsed.checks as { verificacoes: Record<string, unknown>[] }).verificacoes;
    expect(checks).toEqual([expect.objectContaining({ ok: true })]);
    expect(checks[0]).not.toHaveProperty('saida');
    expect(run.rodadas[0]?.verificacoes[0]).toHaveProperty('saida');
    expect(events.some((e) => e.topic === 'run.done')).toBe(true);

    const got = await client.request<{ task: Task }>('tasks.get', { taskId: task.id });
    expect(got.task.status).toBe('concluída');
  }, 60_000);

  it('merge barrado por um gancho do projeto diz o motivo, não "conflito"', async () => {
    await writeFile(
      join(repo, '.git', 'hooks', 'commit-msg'),
      '#!/bin/sh\ngrep -q "fakl: Criar" "$1" || exit 0\necho "mensagem recusada pelo gancho" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    await startCore();
    const task = await createTask();
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status === 'concluída' || r.status === 'falhou');
    expect(run.resultado).toBe('branch');
    expect(run.motivo).toMatch(/mensagem recusada pelo gancho/);
    expect(run.motivo).not.toMatch(/conflito|conflict/);
    expect(git('status', '--porcelain')).toBe('');
    expect(git('log', '-1', '--format=%s', 'main')).toBe('inicial');
  }, 60_000);

  /** Entrega `pr-merge` por uma API do GitHub falsa; `config` vai no config.yaml. */
  const deliverWithMerge = async (config?: string) => {
    if (config !== undefined) {
      await mkdir(join(dir, 'home', '.fakl'), { recursive: true });
      await writeFile(join(dir, 'home', '.fakl', 'config.yaml'), config);
    }
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
    await writeFile(
      join(repo, '.github', 'workflows', 'build.yml'),
      'on:\n  workflow_dispatch:\n    inputs:\n      plataformas:\n        type: choice\n',
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'build');
    const remote = join(dir, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    // O PR vai pela API (falsa) de acme/web; o push, para o repositório local.
    git('remote', 'add', 'origin', 'https://github.com/acme/web.git');
    git('remote', 'set-url', '--push', 'origin', remote);

    const calls: { method: string; path: string; body?: unknown }[] = [];
    await startCore('completo', false, (url, init) => {
      const method = init?.method ?? 'GET';
      const path = new URL(url).pathname;
      calls.push({
        method,
        path,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      const reply = (body: unknown, status = 200): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (method === 'POST' && path.endsWith('/pulls')) {
        return reply({ number: 7, html_url: 'https://github.com/acme/web/pull/7' }, 201);
      }
      if (method === 'PUT' && path.endsWith('/pulls/7/merge')) {
        return reply({ merged: true, sha: 'abc', message: 'Pull Request successfully merged' });
      }
      if (method === 'POST' && path.endsWith('/dispatches')) {
        return reply({ html_url: 'https://github.com/acme/web/actions/runs/99' });
      }
      return reply({});
    });
    await client.request('secrets.set', { nome: 'github.token', valor: 'gh-teste' });
    const task = await createTask({ entrega: undefined });
    expect(task.entrega).toBeUndefined();
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status === 'concluída' || r.status === 'falhou');
    return { run, calls, remote, task };
  };

  it('por padrão, entrega com PR e merge no GitHub, sem disparar build', async () => {
    const { run, calls } = await deliverWithMerge();

    expect(run.status).toBe('concluída');
    expect(run.resultado).toBe('merge');
    expect(run.prUrl).toBe('https://github.com/acme/web/pull/7');
    expect(run.buildUrl).toBeUndefined();
    expect(run.motivo).toMatch(/PR mesclado em main; nenhum build configurado/);
    expect(calls.some((c) => c.path.endsWith('/dispatches'))).toBe(false);
  }, 60_000);

  it('com buildAposMerge, dispara o workflow só com as entradas que ele declara', async () => {
    const { run, calls, remote, task } = await deliverWithMerge(
      'buildAposMerge:\n  workflow: build.yml\n  inputs: { plataformas: windows, inexistente: x }\n',
    );

    expect(run.status).toBe('concluída');
    expect(run.resultado).toBe('merge');
    expect(run.prUrl).toBe('https://github.com/acme/web/pull/7');
    expect(run.buildUrl).toBe('https://github.com/acme/web/actions/runs/99');
    expect(run.motivo).toMatch(/PR mesclado em main; build\.yml disparado/);
    expect(
      execFileSync('git', ['--git-dir', remote, 'cat-file', '-e', `${run.branch}:novo.txt`]),
    ).toBeDefined();
    // O título da tarefa é a frase do usuário: PR e squash saem em Conventional Commits.
    const prTitle = (
      calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))?.body as
        { title?: string } | undefined
    )?.title;
    expect(prTitle).toBe(deliveryTitle(task.titulo, []));
    expect(prTitle).toMatch(/^chore: /);
    expect(calls.find((c) => c.path.endsWith('/pulls/7/merge'))?.body).toMatchObject({
      merge_method: 'squash',
      commit_title: `${prTitle ?? ''} (#7)`,
    });
    expect(calls.find((c) => c.path.endsWith('/dispatches'))).toMatchObject({
      path: '/repos/acme/web/actions/workflows/build.yml/dispatches',
      body: { ref: 'main', inputs: { plataformas: 'windows' } },
    });
    expect(
      (calls.find((c) => c.path.endsWith('/dispatches'))?.body as { inputs: object }).inputs,
    ).not.toHaveProperty('inexistente');
    // A pasta do usuário não muda: o merge foi no GitHub.
    expect(() => git('cat-file', '-e', 'main:novo.txt')).toThrow();
  }, 60_000);

  it('o maestro acha um agente e delega com ele, no perfil sugerido', async () => {
    const library = join(dir, 'home', '.fakl', 'resources', 'agents');
    await mkdir(library, { recursive: true });
    await writeFile(
      join(library, 'escritor.md'),
      '---\nname: escritor\ndescription: Escreve arquivos de texto.\nfakl:\n  nivel: leve\n  perfil: falso\n---\n\nEscreva com capricho.\n',
    );
    // Sem economia, spawn_agent sem perfil continua pedindo o profileId (com ela, o roteador escolhe).
    await mkdir(join(dir, 'home', '.fakl'), { recursive: true });
    await writeFile(join(dir, 'home', '.fakl', 'config.yaml'), 'economia: desligado\n');
    await startCore('recursos');
    const task = await createTask();
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status === 'concluída' || r.status === 'falhou');

    expect(run.status).toBe('concluída');
    const log = JSON.parse(
      events
        .filter((e) => e.topic === 'agent.output')
        .map((e) => (e.data as AgentOutputEventData).text)
        .find((text) => text.startsWith('{"tools"')) ?? '{}',
    ) as Record<string, unknown>;
    expect(log.tools).toEqual(expect.arrayContaining(['find_resources', 'get_resource']));
    expect((log.found as unknown[])[0]).toMatchObject({
      kind: 'agent',
      name: 'escritor',
      perfil: 'falso',
      instalado: true,
    });
    expect(log.sugestao).toMatchObject({ complexidade: 'baixa' });
    expect(['falso', 'maestro']).toContain((log.sugestao as { profileId: string }).profileId);
    expect(String((log.semPerfil as { erro?: string }).erro)).toMatch(/passe profileId/);
    expect(String((log.inexistente as { erro?: string }).erro)).toMatch(/nenhum/);
    expect(String((log.perfilInvalido as { erro?: string }).erro)).toMatch(/profileId/);
    expect(log.spawned).toMatchObject({ profileId: 'falso', recursos: ['agent:escritor'] });
    expect(run.agentes.map((a) => [a.profileId, a.papel])).toEqual([
      ['maestro', 'maestro'],
      ['falso', 'executor'],
    ]);
  }, 60_000);

  it('uma sessão do Claude recebe os ganchos da economia e o explorador mais barato', async () => {
    await startCore('completo', false, undefined, [
      {
        id: 'claude-caro',
        nome: 'Caro',
        provedor: 'anthropic',
        adaptador: 'acp',
        modelo: 'caro-1',
      },
      {
        id: 'claude-leve',
        nome: 'Leve',
        provedor: 'anthropic',
        adaptador: 'acp',
        modelo: 'leve-1',
        custoRelativo: 'baixo',
      },
    ]);
    const metaDe = async (profileId: string): Promise<unknown> => {
      const { sessionId } = await client.request<{ sessionId: string }>('agents.start', {
        profileId,
        cwd: repo,
      });
      await client.request('agents.send', { sessionId, message: 'meta' });
      let text: string | undefined;
      await waitFor(() => {
        text = events
          .filter((e) => e.topic === 'agent.output' && e.subject === sessionId)
          .map((e) => (e.data as AgentOutputEventData).text)
          .find((t) => t.startsWith('{') || t === 'null');
        return text !== undefined;
      }, 20_000);
      await client.request('agents.stop', { sessionId });
      return JSON.parse(text ?? 'null');
    };
    const options = (
      (await metaDe('claude-caro')) as {
        claudeCode: {
          options: {
            settings: { hooks: Record<string, { hooks: { command: string }[] }[]> };
            agents?: Record<string, { model: string }>;
          };
        };
      }
    ).claudeCode.options;
    const comando = options.settings.hooks.PostToolUse?.[0]?.hooks[0]?.command ?? '';
    expect(comando).toContain('--gancho');
    expect(comando).toContain("FAKL_ECONOMIA='equilibrado'");
    expect(options.agents?.explorador?.model).toBe('leve-1');
    // O mais barato não tem para quem descer; outro provedor não recebe nada.
    expect(
      (await metaDe('claude-leve')) as { claudeCode: { options: { agents?: unknown } } },
    ).not.toHaveProperty('claudeCode.options.agents');
    expect(await metaDe('falso')).toBeNull();
  }, 60_000);

  it('uma sessão do chat chama outro agente sem tarefa (Maestro Mode)', async () => {
    await startCore();
    const started = await client.request<{ sessionId: string; worktree?: { branch: string } }>(
      'agents.start',
      { profileId: 'maestro', cwd: repo, worktree: true },
    );
    await client.request('agents.send', { sessionId: started.sessionId, message: 'Delegue.' });

    let log: Record<string, unknown> | undefined;
    await waitFor(() => {
      const text = events
        .filter((e) => e.topic === 'agent.output' && e.subject === started.sessionId)
        .map((e) => (e.data as AgentOutputEventData).text)
        .find((t) => t.startsWith('{"tools"'));
      if (text) log = JSON.parse(text) as Record<string, unknown>;
      return log !== undefined;
    }, 30_000);
    if (!log) throw new Error('a sessão do chat não respondeu');

    // O chat recebe as ferramentas de orquestração, menos finish.
    expect(log.tools).toEqual(expect.arrayContaining(['spawn_agent', 'await_results']));
    expect(log.tools).not.toContain('finish');
    expect(typeof (log.spawned as { sessionId?: unknown }).sessionId).toBe('string');
    expect(log.merge).toEqual([expect.objectContaining({ ok: true })]);

    // Execução implícita: o chat é o maestro e o subagente fica ligado a ele (cabos da Mesa).
    const tasks = await client.request<Task[]>('tasks.list');
    const chat = tasks.find((t) => t.origem === 'chat');
    expect(chat?.titulo).toBe('Chat com Maestro');
    const detail = await client.request<{ runs: Run[] }>('tasks.get', { taskId: chat?.id });
    const run = detail.runs[0];
    expect(run?.status).toBe('executando');
    expect(run?.maestroSessionId).toBe(started.sessionId);
    expect(run?.agentes.map((a) => [a.profileId, a.papel, a.parentSessionId ?? null])).toEqual([
      ['maestro', 'maestro', null],
      ['falso', 'executor', started.sessionId],
    ]);
    expect(events.filter((e) => e.topic === 'run.agents' && e.subject === run?.id)).toHaveLength(2);
    // O trabalho do subagente chegou ao branch da conversa, não ao main.
    const branch = started.worktree?.branch ?? '';
    expect(git('show', `${branch}:novo.txt`)).toBe('um\ndois\ntrês');
    expect(git('ls-tree', '--name-only', 'main').split('\n')).not.toContain('novo.txt');

    // Fechar a conversa encerra a execução implícita, sem entrega.
    await client.request('agents.stop', { sessionId: started.sessionId });
    const done = await waitRun(run?.id ?? '', (r) => r.status !== 'executando');
    expect(done.status).toBe('concluída');
    expect(done.resultado).toBe('branch');

    // Retomada, a mesma conversa delega de novo numa execução implícita nova.
    const before = events.length;
    await client.request('agents.send', { sessionId: started.sessionId, message: 'Delegue.' });
    let again: Record<string, unknown> | undefined;
    await waitFor(() => {
      const text = events
        .slice(before)
        .filter((e) => e.topic === 'agent.output' && e.subject === started.sessionId)
        .map((e) => (e.data as AgentOutputEventData).text)
        .find((t) => t.startsWith('{"tools"'));
      if (text) again = JSON.parse(text) as Record<string, unknown>;
      return again !== undefined;
    }, 30_000);
    expect(typeof (again?.spawned as { sessionId?: unknown } | undefined)?.sessionId).toBe(
      'string',
    );
    const chats = (await client.request<Task[]>('tasks.list')).filter((t) => t.origem === 'chat');
    expect(chats).toHaveLength(2);
  }, 90_000);

  it('o maestro delega a dois subagentes em paralelo, cada um no seu worktree, e entrega', async () => {
    await startCore('dupla');
    const trees = new Map<string, string>();
    const concurrent: number[] = [];
    const poll = setInterval(() => {
      void client
        .request<AgentSessionInfo[]>('agents.list')
        .then((list) => {
          const live = list.filter((s) => s.worktree && !isFinalAgentState(s.state));
          for (const s of live) if (s.worktree) trees.set(s.sessionId, s.worktree.path);
          concurrent.push(live.length);
        })
        .catch(() => undefined);
    }, 100);
    const task = await createTask({
      titulo: 'Criar a.txt e b.txt',
      criterio: { comandos: ['git cat-file -e HEAD:a.txt', 'git cat-file -e HEAD:b.txt'] },
    });
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status === 'concluída' || r.status === 'falhou');
    clearInterval(poll);

    expect(run.status).toBe('concluída');
    expect(run.resultado).toBe('merge');
    expect(run.rodadas.map((r) => r.veredito)).toEqual(['passou']);

    // Maestro e dois executores, todos filhos de quem delegou, cada um com branch próprio.
    const workers = run.agentes.filter((a) => a.papel === 'executor');
    expect(workers).toHaveLength(2);
    for (const worker of workers) {
      expect(worker.parentSessionId).toBe(run.maestroSessionId);
      expect(worker.profundidade).toBe(1);
    }
    const branches = run.agentes.map((a) => a.branch);
    expect(new Set(branches).size).toBe(3);
    expect(branches.every((b) => b?.startsWith(`fakl/${task.id}/`))).toBe(true);

    // Os três rodaram em pastas diferentes, e os dois executores ao mesmo tempo.
    expect(new Set(trees.values()).size).toBe(3);
    for (const path of trees.values()) expect(path).toContain(join(dir, 'home', '.fakl'));
    expect(Math.max(...concurrent)).toBeGreaterThanOrEqual(3);

    // O trabalho dos dois chegou ao branch principal por merge.
    expect(git('show', 'main:a.txt')).toMatch(/^feito por \d+$/);
    expect(git('show', 'main:b.txt')).toMatch(/^feito por \d+$/);
    expect(git('log', '-1', '--format=%b', 'main').trim()).toBe('fakl: Criar a.txt e b.txt');
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);

    // Eventos: estado e saída de cada subagente, rodada e fim da execução.
    for (const worker of workers) {
      const mine = events.filter((e) => e.subject === worker.sessionId);
      expect(mine.some((e) => e.topic === 'agent.output')).toBe(true);
    }
    expect(
      events.filter((e) => e.topic === 'run.round' && 'veredito' in (e.data as object)),
    ).toHaveLength(1);
    expect(events.some((e) => e.topic === 'run.done')).toBe(true);

    // A árvore da execução (Mesa) lista o maestro e os dois filhos.
    const tree = await client.request<{ sessionId: string; parentSessionId?: string }[]>(
      'runs.tree',
      { runId: run.id },
    );
    expect(tree).toHaveLength(3);
    expect(tree.filter((n) => n.parentSessionId === run.maestroSessionId)).toHaveLength(2);
  }, 90_000);

  it('respeita o limite de rodadas: a rodada extra não roda e a execução vira rascunho', async () => {
    await startCore('rodadas');
    const task = await createTask({
      titulo: 'Nunca passa',
      criterio: { comandos: ['git cat-file -e HEAD:nunca.txt'] },
      limites: { rodadas: { valor: 2, acao: 'rascunho' } },
    });
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status !== 'executando');

    expect(run.rodadas).toHaveLength(2);
    expect(run.rodadas.map((r) => r.veredito)).toEqual(['falhou', 'falhou']);
    // O que falhou volta com a saída, para o maestro saber o que corrigir.
    const findLog = () =>
      events
        .filter((e) => e.topic === 'agent.output')
        .map((e) => (e.data as AgentOutputEventData).text)
        .find((text) => text.startsWith('{"tools"'));
    await vi.waitFor(
      () => {
        expect(findLog()).toBeDefined();
      },
      { timeout: 10_000 },
    );
    const checks = (JSON.parse(findLog() ?? '{}') as { checks: { verificacoes?: unknown[] }[] })
      .checks;
    const primeira = checks[0]?.verificacoes?.[0] as { ok?: boolean; saida?: unknown } | undefined;
    expect(primeira?.ok).toBe(false);
    expect(typeof primeira?.saida).toBe('string');
    expect(run.status).toBe('falhou');
    expect(events.some((e) => e.topic === 'run.limit')).toBe(true);
    const limit = events.find((e) => e.topic === 'run.limit')?.data as { limite?: string };
    expect(limit.limite).toBe('rodadas');
  }, 60_000);

  it('um commit do mesmo conteúdo depois da rodada aprovada não roda o critério de novo', async () => {
    await startCore('commit');
    const task = await createTask({
      titulo: 'Criar novo.txt',
      criterio: { comandos: ['git --version'] },
    });
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status === 'concluída' || r.status === 'falhou');

    expect(run.status).toBe('concluída');
    expect(run.rodadas.map((r) => r.veredito)).toEqual(['passou']);
    expect(git('show', 'main:novo.txt')).toBe('feito pelo maestro');
  }, 60_000);

  it('retoma sozinho a execução que uma queda do Core interrompeu', async () => {
    await startCore();
    const task = await createTask();
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    client.close();
    await core.stop();
    await socket.cleanup();

    await startCore('completo', true);
    const run = await waitRun(started.id, (r) => r.status === 'concluída' || r.status === 'falhou');
    expect(run.status).toBe('concluída');
    expect(git('show', 'main:novo.txt')).toBe('um\ndois\ntrês');
  }, 90_000);

  it('recusa o token do maestro fora das ferramentas dele', async () => {
    await startCore();
    await expect(
      CoreClient.connect(socket.path, 'token-inventado', 'agent'),
    ).rejects.toBeInstanceOf(CoreRpcError);
  });

  it('falha quando o maestro desiste e lembra quem para sem terminar', async () => {
    await startCore('falha');
    const task = await createTask();
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status !== 'executando');
    expect(run.status).toBe('falhou');
    expect(run.motivo).toBe('não deu');
  }, 60_000);

  it('pergunta quando o maestro para de vez e descarta se pedido', async () => {
    await startCore('parado');
    const task = await createTask();
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    await waitFor(() => events.some((e) => e.topic === 'run.decision'), 30_000);
    const pending = await client.request<Decision[]>('runs.decisions');
    expect(pending[0]?.opcoes.map((o) => o.id)).toEqual(['continuar', 'rascunho', 'descartar']);
    await client.request('runs.decide', {
      runId: started.id,
      decisionId: pending[0]?.id,
      escolha: 'descartar',
    });
    const run = await waitRun(started.id, (r) => r.status === 'descartada');
    expect(run.resultado).toBe('descartado');
    expect(git('branch', '--list', 'fakl/*')).toBe('');
  }, 60_000);

  it('no autopilot, segue sozinho pela opção segura quando o maestro para', async () => {
    await startCore('parado');
    const task = await createTask({ permissoes: 'autopilot' });
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status !== 'executando');
    expect(run.decisoes).toEqual([
      expect.objectContaining({ escolha: 'rascunho', origemResposta: 'autopilot' }),
    ]);
    expect(await client.request<Decision[]>('runs.decisions')).toEqual([]);
    await expect(
      client.request('tasks.create', { titulo: 'x', repoPath: repo, permissoes: 'tudo' }),
    ).rejects.toBeInstanceOf(CoreRpcError);
  }, 60_000);

  it('o maestro pausado pelo freio recebe o motivo e volta a trabalhar', async () => {
    await mkdir(join(dir, 'home', '.fakl'), { recursive: true });
    await writeFile(join(dir, 'home', '.fakl', 'config.yaml'), 'freio:\n  repeticoes: 3\n');
    await startCore('freio');
    const task = await createTask({ permissoes: 'autopilot' });
    const started = await client.request<Run>('runs.start', { taskId: task.id });
    const run = await waitRun(started.id, (r) => r.status !== 'executando');
    expect({ status: run.status, motivo: run.motivo }).toEqual({
      status: 'concluída',
      motivo: undefined,
    });
    expect(run.decisoes).toEqual([]);
    expect(git('cat-file', '-p', 'HEAD:novo.txt')).toBeTruthy();
  }, 60_000);

  it('sem maestro na tarefa, o modo econômico escolhe o perfil pelo tamanho dela', async () => {
    await startCore('parado', false, undefined, [
      {
        id: 'maestro-caro',
        nome: 'Caro',
        provedor: 'teste',
        adaptador: 'acp',
        podeSerMaestro: true,
        custoRelativo: 'alto',
      },
    ]);
    const maestroDe = async (extra: Record<string, unknown>): Promise<string | undefined> => {
      const task = await createTask({ maestroProfileId: undefined, entrega: 'branch', ...extra });
      const run = await client.request<Run>('runs.start', { taskId: task.id });
      await client.request('runs.stop', { runId: run.id });
      return run.agentes.find((a) => a.papel === 'maestro')?.profileId;
    };
    // Pedido curto e comum: o maestro de custo médio basta.
    expect(await maestroDe({})).toBe('maestro');
    // Segurança e refatoração ampla: o perfil forte.
    expect(
      await maestroDe({
        titulo: 'Refatorar a autenticação OAuth',
        descricao:
          'Refatoração ampla da autenticação, com revisão de segurança em vários arquivos.',
      }),
    ).toBe('maestro-caro');
  }, 60_000);

  it('no modo econômico, o maestro recebe o executor mais barato da parte delegada', async () => {
    await startCore('eco', false, undefined, [
      { id: 'barato', nome: 'Barato', provedor: 'teste', adaptador: 'acp', custoRelativo: 'baixo' },
    ]);
    // Tarefa de nível médio: sozinha iria ao perfil médio; delegada, desce ao barato.
    const titulo = 'Implementar a paginação da listagem de pedidos';
    const descricao =
      'A listagem de pedidos carrega tudo de uma vez. Paginar no servidor com limite e deslocamento, ' +
      'mostrar a navegação entre páginas na tela e manter o filtro de status ao trocar de página.';
    expect(classificarComplexidade(`${titulo}\n${descricao}`).nivel).toBe('media');
    const task = await createTask({ titulo, descricao, entrega: 'branch' });
    const run = await client.request<Run>('runs.start', { taskId: task.id });
    let prompt = '';
    await vi.waitFor(
      () => {
        prompt =
          events
            .filter((e) => e.topic === 'agent.output')
            .map((e) => (e.data as AgentOutputEventData).text)
            .find((text) => text.includes(titulo)) ?? '';
        expect(prompt).not.toBe('');
      },
      { timeout: 20_000 },
    );
    await client.request('runs.stop', { runId: run.id });
    expect(prompt).toContain('a implementação desta tarefa vai para barato');
    expect(prompt).toContain('spawn_agent (profileId barato)');
  }, 60_000);

  it('valida a tarefa', async () => {
    await startCore();
    await expect(
      client.request('tasks.create', { titulo: '', repoPath: repo }),
    ).rejects.toBeInstanceOf(CoreRpcError);
    await expect(
      client.request('tasks.create', { titulo: 'x', repoPath: 'relativo' }),
    ).rejects.toBeInstanceOf(CoreRpcError);
    await expect(
      client.request('tasks.create', { titulo: 'x', repoPath: repo, entrega: 'email' }),
    ).rejects.toBeInstanceOf(CoreRpcError);
    await expect(
      client.request('tasks.create', { titulo: 'x', repoPath: repo, perfisPermitidos: 'falso' }),
    ).rejects.toBeInstanceOf(CoreRpcError);
  });

  it('guarda os modelos permitidos, incluindo os dos papéis fixados', async () => {
    await startCore();
    const livre = await createTask();
    expect(livre.perfisPermitidos).toBeUndefined();
    const restrita = await createTask({
      perfisPermitidos: ['falso'],
      papeisFixados: { revisor: 'maestro' },
    });
    expect(restrita.perfisPermitidos).toEqual(['falso', 'maestro']);
    const sozinha = await createTask({ perfisPermitidos: [] });
    expect(sozinha.perfisPermitidos).toEqual([]);
  });
});

describe('título da entrega', () => {
  it('mantém o título da tarefa que já segue Conventional Commits', () => {
    expect(deliveryTitle('fix(core): corrige o merge', ['feat: outra coisa'])).toBe(
      'fix(core): corrige o merge',
    );
  });

  it('usa o primeiro commit convencional do branch, sem os pontos de salvamento', () => {
    expect(
      deliveryTitle('colocar a opção de entrega pr e merge', [
        'fakl: trabalho do maestro antes de delegar',
        'feat(core): entrega pr-merge do maestro',
        'fix(core): confere o merge pelo gh',
      ]),
    ).toBe('feat(core): entrega pr-merge do maestro');
  });

  it('cai para chore quando nenhum commit segue o padrão', () => {
    expect(deliveryTitle('  arrumar a memória ', ['fakl: trabalho de codex'])).toBe(
      'chore: arrumar a memória',
    );
  });
});
