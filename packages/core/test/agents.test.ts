import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpAdapter } from '@fakl/agents';
import {
  FaklErrorCode,
  type AgentDiffResult,
  type AgentOutputEventData,
  type AgentProfileAvailability,
  type AgentSessionInfo,
  type AgentStartResult,
  type AgentStateEventData,
  type AgentTerminalAttachResult,
  type AgentTerminalLinesParams,
  type AgentTranscriptResult,
  type EventNotificationParams,
  type FaklEvent,
} from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CoreClient,
  CoreRpcError,
  createCore,
  createSessionToken,
  HostBridge,
  notificationFor,
  type Core,
  type ToHost,
} from '../src/index.js';
import { testSocket, waitFor } from './helpers.js';

const fakeAgent = fileURLToPath(
  new URL('../../agents/test/fixtures/fake-agent.mjs', import.meta.url),
);

// Cada teste sobe agentes e worktrees de verdade; no runner do CI dividido com builds, 5 s não bastam.
describe('Core: agentes', { timeout: 20_000 }, () => {
  let socket: Awaited<ReturnType<typeof testSocket>>;
  let core: Core;
  let client: CoreClient;
  let cwd: string;
  let token: string;
  const events: FaklEvent[] = [];

  beforeEach(async () => {
    socket = await testSocket();
    cwd = await mkdtemp(join(tmpdir(), 'fakl-core-agent-'));
    token = createSessionToken();
    core = createCore({
      socketPath: socket.path,
      token,
      agents: {
        home: join(cwd, 'home'),
        profiles: [
          { id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' },
          { id: 'ausente', nome: 'Ausente', provedor: 'teste', adaptador: 'acp' },
        ],
        adapterFor: (profile) =>
          profile.id === 'falso'
            ? new AcpAdapter({ command: process.execPath, args: [fakeAgent] })
            : new AcpAdapter({ command: 'agente-ausente', args: [], install: 'npm i -g ausente' }),
      },
    });
    await core.start();
    client = await CoreClient.connect(socket.path, token, 'test');
    events.length = 0;
    client.onNotification((_method, params) => {
      events.push((params as EventNotificationParams).event);
    });
    await client.request('events.subscribe', { topics: ['agent.*', 'cost.update'] });
  });

  afterEach(async () => {
    client.close();
    await core.stop();
    await socket.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });

  it('lista os perfis e se estão instalados', async () => {
    const result = await client.request<AgentProfileAvailability[]>('agents.detect');
    expect(result.map((p) => [p.id, p.availability.status])).toEqual([
      ['falso', 'pronto'],
      ['ausente', 'não-instalado'],
    ]);
  });

  it('inicia um agente, conversa e publica os eventos', async () => {
    const { sessionId } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
    });
    await client.request('agents.send', { sessionId, message: 'olá' });
    await waitFor(
      () =>
        events.some(
          (e) => e.topic === 'agent.state' && (e.data as { state: string }).state === 'ocioso',
        ),
      5_000,
    );
    const output = events.find((e) => e.topic === 'agent.output');
    expect(output?.subject).toBe(sessionId);
    // A regra de foco vai como prompt de sistema na primeira mensagem.
    expect((output?.data as AgentOutputEventData).text).toBe('oi (2 blocos)');
    expect(events.some((e) => e.topic === 'cost.update')).toBe(true);

    const [info] = await client.request<AgentSessionInfo[]>('agents.list');
    expect(info).toMatchObject({ sessionId, profileId: 'falso', state: 'ocioso', cwd });
  });

  it('mostra o agente no terminal de leitura: histórico, linhas novas e detach', async () => {
    const { sessionId } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
    });
    const leitor = await CoreClient.connect(socket.path, token, 'test');
    try {
      const novas: AgentTerminalLinesParams[] = [];
      leitor.onNotification((method, params) => {
        if (method === 'agents.terminal.lines') novas.push(params as AgentTerminalLinesParams);
      });
      const inicial = await leitor.request<AgentTerminalAttachResult>('agents.terminal.attach', {
        sessionId,
      });
      expect(inicial.sessionId).toBe(sessionId);
      const ate = inicial.lines.at(-1)?.seq ?? 0;
      await client.request('agents.send', { sessionId, message: 'olá' });
      await waitFor(() => novas.some((n) => n.lines.some((l) => l.text.includes('ocioso'))), 5_000);
      const texto = novas.flatMap((n) => n.lines.map((l) => l.text)).join('\n');
      expect(texto).toContain('olá');
      expect(novas.flatMap((n) => n.lines).every((l) => l.seq > ate)).toBe(true);
      await leitor.request('agents.terminal.detach', { sessionId });
      const antes = novas.length;
      await client.request('agents.send', { sessionId, message: 'de novo' });
      await waitFor(
        () =>
          events.filter((e) => e.topic === 'agent.state' && e.subject === sessionId).length >= 4,
        5_000,
      );
      expect(novas).toHaveLength(antes);
      const historico = await leitor.request<AgentTerminalAttachResult>('agents.terminal.attach', {
        sessionId,
      });
      expect(historico.lines.map((l) => l.text).join('\n')).toContain('de novo');
    } finally {
      leitor.close();
    }
    await expect(
      client.request('agents.terminal.attach', { sessionId: 'nao-existe' }),
    ).rejects.toMatchObject({ code: FaklErrorCode.NotFound });
  });

  it('guarda a conversa, com o que foi pedido, para quem abre a sessão depois', async () => {
    const { sessionId } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
    });
    await client.request('agents.send', {
      sessionId,
      message: 'olá com anexos',
      exibir: 'olá',
    });
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.subject === sessionId &&
            e.topic === 'agent.state' &&
            (e.data as { state: string }).state === 'ocioso',
        ),
      5_000,
    );
    const prompt = events.find((e) => e.topic === 'agent.prompt' && e.subject === sessionId);
    expect(prompt?.data).toEqual({ text: 'olá' });

    const transcript = await client.request<AgentTranscriptResult>('agents.transcript', {
      sessionId,
    });
    expect(transcript.items[0]).toEqual({ kind: 'user', text: 'olá' });
    // O agente falso ecoa o que recebeu: o texto inteiro, não o exibido.
    const answer = transcript.items.find((item) => item.kind === 'agent');
    expect(answer?.kind === 'agent' && answer.text.endsWith('olá com anexos')).toBe(true);
    expect(transcript.omitidos).toBe(0);
    expect(transcript.ultimoEvento).toBeDefined();

    const short = await client.request<AgentTranscriptResult>('agents.transcript', {
      sessionId,
      limit: 1,
    });
    expect(short.items).toHaveLength(1);
    expect(short.omitidos).toBe(transcript.items.length - 1);

    const info = (await client.request<AgentSessionInfo[]>('agents.list')).find(
      (s) => s.sessionId === sessionId,
    );
    expect(info?.ultimaFala).toBe('olá com anexos');
    expect(info?.iniciadaEm).toMatch(/^\d{4}-/);
    expect(info?.atividadeEm).toMatch(/^\d{4}-/);
    expect(info?.encerradaEm).toBeUndefined();

    await client.request('agents.stop', { sessionId });
    const stopped = (await client.request<AgentSessionInfo[]>('agents.list')).find(
      (s) => s.sessionId === sessionId,
    );
    expect(stopped?.encerradaEm).toMatch(/^\d{4}-/);
  });

  it('avisa o processo principal e espera os agentes ao fechar', async () => {
    const sent: ToHost[] = [];
    const host = new HostBridge({ postMessage: (m) => sent.push(m) }, core.bus, core.agents);
    try {
      const { sessionId } = await client.request<AgentStartResult>('agents.start', {
        profileId: 'falso',
        cwd,
      });
      await client.request('agents.send', { sessionId, message: 'oi' });
      await waitFor(() => sent.some((m) => m.type === 'notify'), 5_000);
      expect(sent.find((m) => m.type === 'notify')).toMatchObject({
        title: 'Falso terminou a vez',
        sessionId,
      });

      await client.request('agents.send', { sessionId, message: 'lento' });
      await waitFor(() => host.busy().length > 0, 5_000);
      host.handle({ type: 'query-busy' });
      expect(sent.at(-1)).toEqual({ type: 'busy', agents: ['Falso'] });
      host.handle({ type: 'wait-idle' });
      expect(sent.some((m) => m.type === 'idle')).toBe(false);
      await client.request('agents.stop', { sessionId });
      await waitFor(() => sent.some((m) => m.type === 'idle'), 5_000);
    } finally {
      host.dispose();
    }
  });

  it('só notifica o que pede atenção', () => {
    const event = (data: unknown, topic = 'agent.state') =>
      ({ id: '1', topic, subject: 's', ts: '', data }) as Parameters<typeof notificationFor>[0];
    const s = { nome: 'Claude' };
    expect(notificationFor(event({ state: 'pensando', previous: 'ocioso' }), s)).toBeUndefined();
    expect(
      notificationFor(event({ state: 'parado', previous: 'ocioso', reason: 'usuário' }), s),
    ).toBeUndefined();
    expect(notificationFor(event({ state: 'falhou', previous: 'executando' }), s)?.title).toBe(
      'Claude falhou',
    );
    expect(
      notificationFor(
        event({ id: 'p', title: 'Rodar npm test', options: [] }, 'agent.permission'),
        s,
      ),
    ).toEqual({ title: 'Claude pede permissão', body: 'Rodar npm test', urgent: true });
  });

  it('repassa a resposta de permissão e para o agente', async () => {
    const { sessionId } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
    });
    await client.request('agents.send', { sessionId, message: 'permissão' });
    await waitFor(() => events.some((e) => e.topic === 'agent.permission'), 5_000);
    // Quem conecta depois do evento ainda vê o pedido.
    const pending = await client.request<{ sessionId: string; id: string }[]>('agents.permissions');
    expect(pending).toEqual([expect.objectContaining({ sessionId, id: 't1' })]);
    await client.request('agents.permission', { sessionId, id: 't1', allow: true });
    expect(await client.request('agents.permissions')).toEqual([]);
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.topic === 'agent.output' && (e.data as AgentOutputEventData).text === 'resposta: sim',
        ),
      5_000,
    );
    await client.request('agents.stop', { sessionId });
    const [info] = await client.request<AgentSessionInfo[]>('agents.list');
    expect(info?.state).toBe('parado');
  });

  it('troca o modo da sessão viva e libera o pedido que esperava', async () => {
    const { sessionId } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
    });
    let [info] = await client.request<AgentSessionInfo[]>('agents.list');
    expect(info?.permissoes).toBe('perguntar');
    await client.request('agents.send', { sessionId, message: 'permissão' });
    await waitFor(() => events.some((e) => e.topic === 'agent.permission'), 5_000);
    await client.request('agents.setPermissions', { sessionId, permissions: 'autopilot' });
    expect(await client.request('agents.permissions')).toEqual([]);
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.topic === 'agent.output' && (e.data as AgentOutputEventData).text === 'resposta: sim',
        ),
      5_000,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ topic: 'agent.answer', data: { id: 't1', allow: true } }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ topic: 'agent.mode', data: { permissoes: 'autopilot' } }),
    );
    [info] = await client.request<AgentSessionInfo[]>('agents.list');
    expect(info?.permissoes).toBe('autopilot');
    expect(info?.opcoes[0]).toMatchObject({ id: 'model', atual: 'rapido' });
    await client.request('agents.setOption', { sessionId, id: 'model', value: 'forte' });
    expect(events).toContainEqual(expect.objectContaining({ topic: 'agent.options' }));
    await expect(
      client.request('agents.setOption', { sessionId, id: 'model', value: 'nenhum' }),
    ).rejects.toBeInstanceOf(CoreRpcError);
    await expect(
      client.request('agents.setPermissions', { sessionId, permissions: 'tudo' }),
    ).rejects.toBeInstanceOf(CoreRpcError);
    await client.request('agents.stop', { sessionId });
  });

  it('no autopilot, o trabalho fica no branch e a pasta do usuário não muda', async () => {
    const repo = join(cwd, 'repo');
    await mkdir(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Teste');
    git('config', 'user.email', 'teste@exemplo.com');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicial');

    const { sessionId } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: repo,
      worktree: true,
      permissions: 'autopilot',
    });
    await client.request('agents.send', { sessionId, message: 'escreva novo.txt' });
    await waitFor(() => events.some((e) => e.topic === 'agent.file'), 5_000);
    await waitFor(
      () =>
        events.some(
          (e) => e.topic === 'agent.state' && (e.data as AgentStateEventData).state === 'ocioso',
        ),
      5_000,
    );
    const diff = await client.request<AgentDiffResult>('agents.diff', { sessionId });
    expect(diff.files).toEqual([
      { path: 'novo.txt', status: 'adicionado', additions: 3, deletions: 0 },
    ]);
    expect(events.some((e) => e.topic === 'agent.applied')).toBe(false);
    expect(existsSync(join(repo, 'novo.txt'))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
    await client.request('agents.stop', { sessionId });
    await core.agents.stopAll();
    expect(git('show', `fakl/avulso/${sessionId}:novo.txt`)).toBe('um\ndois\ntrês');
  });

  it('repassa "sempre" ao agente; sem ele, a resposta continua avulsa', async () => {
    const { sessionId } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
    });
    const answered = (text: string): boolean =>
      events.some(
        (e) => e.topic === 'agent.output' && (e.data as AgentOutputEventData).text === text,
      );
    await client.request('agents.send', { sessionId, message: 'permissão' });
    await waitFor(() => events.some((e) => e.topic === 'agent.permission'), 5_000);
    // O celular e a extensão mandam só `allow`: o pedido continua valendo uma vez.
    await client.request('agents.permission', { sessionId, id: 't1', allow: true });
    await waitFor(() => answered('resposta: sim'), 5_000);

    events.length = 0;
    await client.request('agents.send', { sessionId, message: 'permissão' });
    await waitFor(() => events.some((e) => e.topic === 'agent.permission'), 5_000);
    await client.request('agents.permission', { sessionId, id: 't1', allow: true, sempre: true });
    await waitFor(() => answered('resposta: sempre'), 5_000);
    await client.request('agents.stop', { sessionId });
  });

  it('guarda o aviso de limite em agents.list e limpa quando o agente volta a trabalhar', async () => {
    const { sessionId } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
    });
    const info = async (): Promise<AgentSessionInfo | undefined> =>
      (await client.request<AgentSessionInfo[]>('agents.list')).find(
        (a) => a.sessionId === sessionId,
      );
    expect((await info())?.limite).toBeUndefined();

    await client.request('agents.send', { sessionId, message: 'limite' });
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.topic === 'agent.output' &&
            (e.data as AgentOutputEventData).kind === 'error' &&
            (e.data as AgentOutputEventData).text.includes('usage limit reached'),
        ),
      5_000,
    );
    // Quem abre o painel depois do aviso ainda o encontra, só a primeira linha.
    const limited = await info();
    expect(limited?.limite?.motivo).toContain('Claude AI usage limit reached');
    expect(limited?.limite?.motivo).not.toContain('Detalhes');
    expect(typeof limited?.limite?.em).toBe('string');

    // Voltou a trabalhar: o aviso deixa de valer.
    await client.request('agents.send', { sessionId, message: 'olá' });
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.topic === 'agent.output' && (e.data as AgentOutputEventData).text.startsWith('oi'),
        ),
      5_000,
    );
    expect((await info())?.limite).toBeUndefined();
    await client.request('agents.stop', { sessionId });
  });

  it('expõe a pasta do projeto quando o agente trabalha num worktree', async () => {
    const repo = join(cwd, 'repo');
    await mkdir(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Teste');
    git('config', 'user.email', 'teste@exemplo.com');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicial');
    const same = (a: string | undefined, b: string): boolean =>
      a?.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

    const { sessionId, worktree } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: repo,
      worktree: true,
    });
    const [info] = await client.request<AgentSessionInfo[]>('agents.list');
    // `cwd` é o worktree; as pastas recentes precisam da pasta de onde ele saiu.
    expect(info?.cwd).toBe(worktree?.path);
    expect(same(info?.pastaOrigem, git('rev-parse', '--show-toplevel'))).toBe(true);
    await client.request('agents.stop', { sessionId });
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.topic === 'agent.state' &&
            e.subject === sessionId &&
            (e.data as AgentStateEventData).state === 'parado',
        ),
      5_000,
    );

    // Sem worktree, a pasta é a própria `cwd`: nada a acrescentar.
    const plain = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
    });
    const listed = (await client.request<AgentSessionInfo[]>('agents.list')).find(
      (a) => a.sessionId === plain.sessionId,
    );
    expect(listed?.pastaOrigem).toBeUndefined();
    await client.request('agents.stop', { sessionId: plain.sessionId });
  });

  it('isola o agente num worktree e guarda o trabalho no branch ao parar', async () => {
    const repo = join(cwd, 'repo');
    await mkdir(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Teste');
    git('config', 'user.email', 'teste@exemplo.com');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicial');

    const { sessionId, worktree } = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: repo,
      worktree: true,
    });
    expect(worktree?.branch).toBe(`fakl/avulso/${sessionId}`);
    expect(worktree?.path).toBe(join(cwd, 'home', '.fakl', 'worktrees', 'repo', sessionId));

    await client.request('agents.send', { sessionId, message: 'escreva novo.txt' });
    await waitFor(() => events.some((e) => e.topic === 'agent.file'), 5_000);
    expect(existsSync(join(repo, 'novo.txt'))).toBe(false);

    const diff = await client.request<AgentDiffResult>('agents.diff', { sessionId });
    expect(diff.files).toEqual([
      { path: 'novo.txt', status: 'adicionado', additions: 3, deletions: 0 },
    ]);
    const content = await client.request<{ base64?: string }>('agents.fileContent', {
      sessionId,
      path: 'novo.txt',
      side: 'agente',
    });
    expect(Buffer.from(content.base64 ?? '', 'base64').toString()).toBe('um\ndois\ntrês');

    await client.request('agents.applyFiles', { sessionId, paths: ['novo.txt'] });
    expect(existsSync(join(repo, 'novo.txt'))).toBe(true);
    const after = await client.request<AgentDiffResult>('agents.diff', { sessionId });
    expect(after.files[0]?.resolution).toBe('aplicado');
    // O diff aceito vira evento, e o placar (que só escuta o barramento) o conta para o perfil.
    expect(events.find((e) => e.topic === 'agent.review')?.data).toEqual({
      aceitos: 1,
      rejeitados: 0,
    });
    expect(core.scorecard.get('total').perfis[0]).toMatchObject({
      perfilId: 'falso',
      sessoes: 1,
      arquivosAceitos: 1,
      taxaAprovacao: 1,
    });

    await client.request('agents.stop', { sessionId });
    await core.agents.stopAll();
    expect(existsSync(worktree?.path ?? '')).toBe(false);
    expect(git('show', `${worktree?.branch ?? ''}:novo.txt`)).toBe('um\ndois\ntrês');
  });

  it('sem git na pasta, o agente sobe mesmo assim, direto nela e sem worktree', async () => {
    const folder = join(cwd, 'sem-git');
    await mkdir(folder);
    const started = await client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: folder,
      worktree: true,
    });
    expect(started.worktree).toBeUndefined();
    const [info] = await client.request<AgentSessionInfo[]>('agents.list');
    expect(info?.sessionId).toBe(started.sessionId);
    await client.request('agents.stop', { sessionId: started.sessionId });
  });

  it('recusa perfil desconhecido, caminho relativo e sessão inexistente', async () => {
    const codes = await Promise.all([
      client.request('agents.start', { profileId: 'nao', cwd }).catch((e: unknown) => e),
      client
        .request('agents.start', { profileId: 'falso', cwd: 'relativo' })
        .catch((e: unknown) => e),
      client.request('agents.send', { sessionId: 'x', message: 'oi' }).catch((e: unknown) => e),
    ]);
    for (const error of codes) expect(error).toBeInstanceOf(CoreRpcError);
    expect((codes[0] as CoreRpcError).code).toBe(FaklErrorCode.NotFound);
  });
});
