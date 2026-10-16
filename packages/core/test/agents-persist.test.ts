import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpAdapter } from '@fakl/agents';
import type {
  AgentSessionInfo,
  AgentStartResult,
  AgentTranscriptEntry,
  ChatItem,
  AgentTranscriptResult,
  EventNotificationParams,
  FaklEvent,
} from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CoreClient,
  createCore,
  createSessionToken,
  historyContext,
  migrateRecord,
  MAX_TRANSCRIPT_ENTRIES,
  SESSION_FORMAT,
  trimTranscript,
  type Core,
} from '../src/index.js';
import { testSocket, waitFor } from './helpers.js';

const fakeAgent = fileURLToPath(
  new URL('../../agents/test/fixtures/fake-agent.mjs', import.meta.url),
);

interface Running {
  core: Core;
  client: CoreClient;
  events: FaklEvent[];
  close(): Promise<void>;
}

describe('Core: agentes que sobrevivem ao reinício', () => {
  let root: string;
  let agentsDir: string;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-persist-'));
    agentsDir = join(root, 'home', '.fakl', 'data', 'agents');
    await mkdir(join(root, 'work'), { recursive: true });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });

  /** Sobe um Core que usa a mesma pasta pessoal, como a IDE depois de reiniciar. */
  async function boot(env: Record<string, string> = {}): Promise<Running> {
    const socket = await testSocket();
    const token = createSessionToken();
    const core = createCore({
      socketPath: socket.path,
      token,
      configHome: join(root, 'home'),
      agents: {
        home: join(root, 'home'),
        profiles: [{ id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' }],
        adapterFor: () => new AcpAdapter({ command: process.execPath, args: [fakeAgent], env }),
      },
    });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    const events: FaklEvent[] = [];
    client.onNotification((_method, params) => {
      events.push((params as EventNotificationParams).event);
    });
    await client.request('events.subscribe', { topics: ['agent.*'] });
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      client.close();
      await core.stop();
      await socket.cleanup();
    };
    cleanups.push(close);
    return { core, client, events, close };
  }

  /** Espera a resposta chegar e a vez do agente terminar. */
  const reply = (running: Running): Promise<void> =>
    waitFor(
      () =>
        running.events.some((e) => e.topic === 'agent.output') &&
        running.events.some(
          (e) => e.topic === 'agent.state' && (e.data as { state: string }).state === 'ocioso',
        ),
      8_000,
    );

  const text = (items: readonly ChatItem[]): string[] =>
    items.flatMap((item) => {
      if (item.kind === 'user') return [`> ${item.text}`];
      return item.kind === 'agent' ? [item.text] : [];
    });

  it('grava a sessão e a conversa, e reidrata depois de reiniciar o Core', async () => {
    const first = await boot();
    const cwd = join(root, 'work');
    const { sessionId } = await first.client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd,
      permissions: 'aprovar-leitura',
    });
    await first.client.request('agents.send', { sessionId, message: 'olá' });
    await reply(first);
    await first.close();

    // O que ficou no disco: registro sem segredos e conversa em JSON Lines.
    expect((await readdir(agentsDir)).sort()).toEqual([`${sessionId}.json`, `${sessionId}.jsonl`]);
    const raw = await readFile(join(agentsDir, `${sessionId}.json`), 'utf8');
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(stored).toMatchObject({
      versao: SESSION_FORMAT,
      id: sessionId,
      profileId: 'falso',
      titulo: 'olá',
      permissoes: 'aprovar-leitura',
      estado: 'parado',
      motivo: 'ide-fechando',
      acpSessionId: 's1',
    });
    expect(Object.keys(stored)).not.toContain('env');
    expect(raw).not.toMatch(/AGENT_TOKEN|FAKL_|mcpServers/);
    expect((stored.opcoes as { id: string }[]).map((o) => o.id)).toEqual(['model', 'web']);

    // Core novo, mesma pasta: a sessão volta encerrada e retomável, com a conversa.
    const second = await boot();
    const [info] = await second.client.request<AgentSessionInfo[]>('agents.list');
    expect(info).toMatchObject({
      sessionId,
      profileId: 'falso',
      state: 'parado',
      retomavel: true,
      titulo: 'olá',
      permissoes: 'aprovar-leitura',
      cwd,
    });
    const { items } = await second.client.request<AgentTranscriptResult>('agents.transcript', {
      sessionId,
    });
    expect(text(items)).toEqual(['> olá', 'oi (2 blocos)']);
  });

  it('retoma recriando a sessão com o histórico quando o agente não sabe carregar', async () => {
    const first = await boot();
    const { sessionId } = await first.client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: join(root, 'work'),
    });
    await first.client.request('agents.send', { sessionId, message: 'olá' });
    await reply(first);
    await first.close();

    const second = await boot();
    await second.client.request('agents.send', { sessionId, message: 'olá' });
    await waitFor(
      () =>
        second.events.some(
          (e) => e.topic === 'agent.output' && (e.data as { text: string }).text.startsWith('oi ('),
        ),
      8_000,
    );
    // Prompt de sistema, histórico da conversa e a mensagem: três blocos.
    const output = second.events.find((e) => e.topic === 'agent.output');
    expect((output?.data as { text: string }).text).toBe('oi (3 blocos)');
    const resumed = second.events.find(
      (e) =>
        e.topic === 'agent.state' && (e.data as { reason?: string }).reason?.startsWith('retomada'),
    );
    expect((resumed?.data as { reason: string }).reason).toBe(
      'retomada com o histórico da conversa',
    );
    const [info] = await second.client.request<AgentSessionInfo[]>('agents.list');
    expect(info).toMatchObject({ sessionId, state: 'ocioso' });
    expect(info?.retomavel).toBeUndefined();
  });

  it('retoma pela sessão do próprio agente quando ele suporta session/load', async () => {
    const first = await boot({ FAKE_LOAD: '1' });
    const { sessionId } = await first.client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: join(root, 'work'),
    });
    await first.client.request('agents.send', { sessionId, message: 'olá' });
    await reply(first);
    await first.close();

    const second = await boot({ FAKE_LOAD: '1' });
    await second.client.request('agents.send', { sessionId, message: 'olá' });
    await waitFor(() => second.events.some((e) => e.topic === 'agent.output'), 8_000);
    // O agente já tem a conversa: nada de prompt de sistema nem histórico, e a "ANTIGA" reenviada não vira evento.
    const outputs = second.events.filter((e) => e.topic === 'agent.output');
    expect(outputs.map((e) => (e.data as { text: string }).text)).toEqual(['oi (1 blocos)']);
    const resumed = second.events.find(
      (e) =>
        e.topic === 'agent.state' && (e.data as { reason?: string }).reason?.startsWith('retomada'),
    );
    expect((resumed?.data as { reason: string }).reason).toBe('retomada com a sessão do agente');

    // A conversa continua inteira no disco: a antiga e a nova.
    const { items } = await second.client.request<AgentTranscriptResult>('agents.transcript', {
      sessionId,
    });
    expect(text(items)).toEqual(['> olá', 'oi (2 blocos)', '> olá', 'oi (1 blocos)']);
  });

  it('retoma uma sessão que o usuário parou, sem reiniciar o Core', async () => {
    const running = await boot();
    const { sessionId } = await running.client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: join(root, 'work'),
    });
    await running.client.request('agents.stop', { sessionId });
    await waitFor(
      () =>
        running.events.some(
          (e) => e.topic === 'agent.state' && (e.data as { state: string }).state === 'parado',
        ),
      8_000,
    );
    await running.client.request('agents.send', { sessionId, message: 'olá' });
    await waitFor(() => running.events.some((e) => e.topic === 'agent.output'), 8_000);
    const [info] = await running.client.request<AgentSessionInfo[]>('agents.list');
    expect(info?.state).toBe('ocioso');
  });

  it('sessão que o Core deixou trabalhando vira interrompida e retomável', async () => {
    await mkdir(agentsDir, { recursive: true });
    const orphan = {
      versao: SESSION_FORMAT,
      id: '01ORFA0000000000000000000A',
      profileId: 'falso',
      nome: 'Falso',
      cwd: join(root, 'work'),
      permissoes: 'perguntar',
      opcoes: [],
      estado: 'pensando',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
    };
    await writeFile(join(agentsDir, `${orphan.id}.json`), JSON.stringify(orphan));
    const running = await boot();
    const [info] = await running.client.request<AgentSessionInfo[]>('agents.list');
    expect(info).toMatchObject({ sessionId: orphan.id, state: 'parado', retomavel: true });
    const saved = JSON.parse(await readFile(join(agentsDir, `${orphan.id}.json`), 'utf8')) as {
      motivo: string;
    };
    expect(saved.motivo).toBe('interrompida');
  });

  it('ignora registros de versão mais nova e aplica a retenção', async () => {
    await mkdir(agentsDir, { recursive: true });
    const base = {
      versao: SESSION_FORMAT,
      profileId: 'falso',
      nome: 'Falso',
      cwd: join(root, 'work'),
      permissoes: 'perguntar',
      opcoes: [],
      estado: 'parado',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      criadoEm: '2020-01-01T00:00:00.000Z',
    };
    const write = (id: string, extra: Record<string, unknown>): Promise<void> =>
      writeFile(join(agentsDir, `${id}.json`), JSON.stringify({ ...base, id, ...extra }));
    await write('NOVA', { versao: SESSION_FORMAT + 1, atualizadoEm: new Date().toISOString() });
    await write('VELHA', { atualizadoEm: '2020-01-01T00:00:00.000Z' });
    await writeFile(join(agentsDir, 'VELHA.jsonl'), '{"t":"user","text":"x","ts":""}\n');
    await write('RECENTE', { atualizadoEm: new Date().toISOString() });
    const running = await boot();
    const list = await running.client.request<AgentSessionInfo[]>('agents.list');
    expect(list.map((s) => s.sessionId)).toEqual(['RECENTE']);
    // A versão futura continua no disco, intacta; a velha foi apagada com a conversa.
    expect((await readdir(agentsDir)).sort()).toEqual(['NOVA.json', 'RECENTE.json']);
  });

  it('esquece uma sessão encerrada e apaga os arquivos', async () => {
    const first = await boot();
    const { sessionId } = await first.client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: join(root, 'work'),
    });
    await first.close();
    const second = await boot();
    expect(existsSync(join(agentsDir, `${sessionId}.json`))).toBe(true);
    await second.client.request('agents.forget', { sessionId });
    expect(await second.client.request<AgentSessionInfo[]>('agents.list')).toEqual([]);
    expect(existsSync(join(agentsDir, `${sessionId}.json`))).toBe(false);
  });

  it('guarda opções e modo escolhidos e os reaplica ao retomar', async () => {
    const first = await boot();
    const { sessionId } = await first.client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: join(root, 'work'),
    });
    await first.client.request('agents.setOption', { sessionId, id: 'model', value: 'forte' });
    await first.client
      .request('agents.setOption', { sessionId, id: 'web', value: true })
      .catch(() => undefined);
    await first.client.request('agents.setPermissions', { sessionId, permissions: 'autopilot' });
    await first.close();

    const second = await boot();
    const [dormant] = await second.client.request<AgentSessionInfo[]>('agents.list');
    expect(dormant?.permissoes).toBe('autopilot');
    expect(dormant?.opcoes.find((o) => o.id === 'model')?.atual).toBe('forte');
    // Mudar com a sessão encerrada vale quando ela voltar.
    await second.client.request('agents.setOption', { sessionId, id: 'model', value: 'rapido' });
    await second.client.request('agents.setOption', { sessionId, id: 'model', value: 'forte' });
    await second.client.request('agents.resume', { sessionId });
    const [live] = await second.client.request<AgentSessionInfo[]>('agents.list');
    expect(live).toMatchObject({ state: 'ocioso', permissoes: 'autopilot' });
    expect(live?.opcoes.find((o) => o.id === 'model')?.atual).toBe('forte');
  });

  it('reabre o worktree do branch ao retomar', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    await writeFile(join(repo, 'a.txt'), 'a');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicio');

    const first = await boot();
    const started = await first.client.request<AgentStartResult>('agents.start', {
      profileId: 'falso',
      cwd: repo,
      worktree: true,
    });
    const { sessionId, worktree } = started;
    expect(worktree).toBeDefined();
    await first.client.request('agents.send', { sessionId, message: 'escreva novo.txt' });
    await reply(first);
    await first.close();
    // Ao encerrar, o trabalho foi para o branch e a pasta saiu.
    expect(existsSync(worktree?.path ?? '')).toBe(false);

    const second = await boot();
    const [info] = await second.client.request<AgentSessionInfo[]>('agents.list');
    expect(info?.worktree).toEqual(worktree);
    await second.client.request('agents.send', { sessionId, message: 'olá' });
    await waitFor(() => second.events.some((e) => e.topic === 'agent.output'), 8_000);
    expect(existsSync(join(worktree?.path ?? '', 'novo.txt'))).toBe(true);
  });
});

describe('agent-store: formato, limites e histórico', () => {
  const user = (n: number): AgentTranscriptEntry => ({ t: 'user', text: `m${String(n)}`, ts: '' });

  it('migra registros e rejeita os inválidos ou de versão futura', () => {
    const valid = {
      id: 'a',
      profileId: 'p',
      nome: 'P',
      cwd: '/x',
      estado: 'parado',
    };
    expect(migrateRecord(valid)).toMatchObject({ versao: SESSION_FORMAT, permissoes: 'perguntar' });
    expect(migrateRecord({ ...valid, versao: SESSION_FORMAT + 1 })).toBeUndefined();
    expect(migrateRecord({ ...valid, estado: 'inventado' })).toBeUndefined();
    expect(migrateRecord(null)).toBeUndefined();
  });

  it('corta a conversa por quantidade e por tamanho, ficando com o final', () => {
    const many = Array.from({ length: MAX_TRANSCRIPT_ENTRIES + 10 }, (_, i) => user(i));
    const kept = trimTranscript(many);
    expect(kept).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(kept.at(-1)).toEqual(user(MAX_TRANSCRIPT_ENTRIES + 9));
    const big = Array.from({ length: 10 }, (_, i) => ({ ...user(i), text: 'x'.repeat(1000) }));
    expect(trimTranscript(big, 100, 3500).length).toBeLessThanOrEqual(3);
    expect(trimTranscript(big, 100, 1).length).toBe(1);
  });

  it('monta o histórico só com o que o usuário e o agente disseram', () => {
    const entries: AgentTranscriptEntry[] = [
      user(1),
      { t: 'event', topic: 'agent.tool', data: { toolCallId: '1' }, ts: '' },
      { t: 'event', topic: 'agent.output', data: { kind: 'thought', text: 'hmm' }, ts: '' },
      { t: 'event', topic: 'agent.output', data: { kind: 'message', text: 'resposta' }, ts: '' },
    ];
    const history = historyContext(entries);
    expect(history).toContain('Usuário: m1');
    expect(history).toContain('Agente: resposta');
    expect(history).not.toContain('hmm');
    expect(historyContext([])).toBe('');
    expect(historyContext(entries, 10).length).toBeLessThan(history.length);
  });
});
