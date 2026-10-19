import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CoreNotifications,
  type AgentOutputEventData,
  type AgentSessionInfo,
  type AgentStartResult,
  type AgentStateEventData,
  type EventNotificationParams,
  type FaklEvent,
  type TerminalHostCommand,
} from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CoreClient,
  CoreRpcError,
  createCore,
  createSessionToken,
  type Core,
} from '../src/index.js';
import { testSocket, waitFor } from './helpers.js';

const SEGREDO = 'chave-super-secreta-98765';

/** Agente de terminal contra um Core de verdade; o "hospedeiro" faz o papel da extensão da IDE. */
describe('Core: agente de terminal (ponte com a extensão)', { timeout: 20_000 }, () => {
  let socket: Awaited<ReturnType<typeof testSocket>>;
  let core: Core;
  let user: CoreClient;
  let host: CoreClient;
  let cwd: string;
  let token: string;
  const events: FaklEvent[] = [];
  const commands: TerminalHostCommand[] = [];

  beforeEach(async () => {
    socket = await testSocket();
    cwd = await mkdtemp(join(tmpdir(), 'fakl-core-terminal-'));
    token = createSessionToken();
    core = createCore({
      socketPath: socket.path,
      token,
      agents: {
        home: join(cwd, 'home'),
        profiles: [
          {
            id: 'cli',
            nome: 'CLI interativa',
            provedor: 'outro',
            adaptador: 'terminal',
            comando: 'minha-cli',
            args: ['--modo', 'x y'],
            env: { MODO: 'teste' },
            terminal: { prompt: '>\\s*$', silencioSegundos: 1 },
          },
        ],
      },
    });
    await core.start();
    core.secrets.set('apikey.teste', SEGREDO);
    user = await CoreClient.connect(socket.path, token, 'test');
    host = await CoreClient.connect(socket.path, token, 'extension');
    events.length = 0;
    commands.length = 0;
    user.onNotification((_method, params) => {
      events.push((params as EventNotificationParams).event);
    });
    host.onNotification((method, params) => {
      if (method === CoreNotifications.terminalHost) commands.push(params as TerminalHostCommand);
    });
    await user.request('events.subscribe', { topics: ['agent.*'] });
  });

  afterEach(async () => {
    user.close();
    host.close();
    await core.stop();
    await socket.cleanup();
    await rm(cwd, { recursive: true, force: true });
  });

  const states = (): string[] =>
    events
      .filter((e) => e.topic === 'agent.state')
      .map((e) => (e.data as AgentStateEventData).state);

  const start = (permissions: string): Promise<AgentStartResult> =>
    user.request<AgentStartResult>('agents.start', { profileId: 'cli', cwd, permissions });

  const spawned = async (): Promise<Extract<TerminalHostCommand, { type: 'spawn' }>> => {
    await waitFor(() => commands.some((c) => c.type === 'spawn'));
    for (const command of commands) if (command.type === 'spawn') return command;
    throw new Error('spawn não chegou');
  };

  it('recusa iniciar enquanto nenhuma IDE hospeda terminais', async () => {
    await expect(start('aprovar-tudo')).rejects.toThrow(/nenhuma janela da IDE/);
  });

  it('registra a sessão, pede o terminal com o comando do perfil e acompanha os estados', async () => {
    await host.request('agents.terminalHost.register', {});
    const { sessionId } = await start('aprovar-tudo');
    const spawn = await spawned();
    // O comando e os argumentos são os do perfil, separados; a pasta é a do agente.
    expect(spawn).toMatchObject({
      sessionId,
      command: 'minha-cli',
      args: ['--modo', 'x y'],
      cwd,
      env: { MODO: 'teste' },
      prompt: '>\\s*$',
      silencioSegundos: 1,
    });

    const [info] = await user.request<AgentSessionInfo[]>('agents.list');
    expect(info).toMatchObject({
      sessionId,
      profileId: 'cli',
      adaptador: 'terminal',
      state: 'preparando',
      usage: { totalTokens: 0 },
    });

    await host.request('agents.terminalHost.ready', { sessionId });
    await host.request('agents.terminalHost.state', { sessionId, state: 'ocioso' });
    await waitFor(() => states().includes('ocioso'));
  });

  it('entrega a mensagem do maestro como uma linha só e fecha a rodada quando a CLI volta a esperar', async () => {
    await host.request('agents.terminalHost.register', {});
    const { sessionId } = await start('aprovar-tudo');
    await spawned();
    await host.request('agents.terminalHost.state', { sessionId, state: 'ocioso' });
    await waitFor(() => states().includes('ocioso'));

    await user.request('agents.send', {
      sessionId,
      message: 'rode os testes\n\u001b[2Jdepois\nrm -rf /',
    });
    await waitFor(() => commands.some((c) => c.type === 'input'));
    expect(commands.find((c) => c.type === 'input')).toEqual({
      type: 'input',
      sessionId,
      text: 'rode os testes depois rm -rf /',
    });
    await waitFor(() => states().at(-1) === 'executando');

    await host.request('agents.terminalHost.output', {
      sessionId,
      text: `rodando\nchave ${SEGREDO} vazou`,
    });
    await host.request('agents.terminalHost.state', { sessionId, state: 'ocioso' });
    await waitFor(() => states().at(-1) === 'ocioso');

    const saida = events
      .filter((e) => e.topic === 'agent.output')
      .map((e) => (e.data as AgentOutputEventData).text)
      .join('');
    expect(saida).toContain('rodando');
    // A saída do terminal passa pela redação de segredos antes de virar evento.
    expect(saida).not.toContain(SEGREDO);
  });

  it('só digita no terminal em aprovar-tudo ou autopilot; nos outros modos a mensagem é recusada', async () => {
    await host.request('agents.terminalHost.register', {});
    const { sessionId } = await start('perguntar');
    await spawned();
    await host.request('agents.terminalHost.state', { sessionId, state: 'ocioso' });
    await waitFor(() => states().includes('ocioso'));

    await user.request('agents.send', { sessionId, message: 'faça algo' });
    await waitFor(() =>
      events.some(
        (e) =>
          e.topic === 'agent.output' &&
          (e.data as AgentOutputEventData).kind === 'error' &&
          (e.data as AgentOutputEventData).text.includes('Assumir o agente'),
      ),
    );
    expect(commands.some((c) => c.type === 'input')).toBe(false);

    // O usuário libera de forma explícita: a partir daí o Core digita.
    await user.request('agents.setPermissions', { sessionId, permissions: 'autopilot' });
    await user.request('agents.send', { sessionId, message: 'agora pode' });
    await waitFor(() => commands.some((c) => c.type === 'input'));
  });

  it('o fim do comando conclui a sessão; um código de saída diferente de zero a falha', async () => {
    await host.request('agents.terminalHost.register', {});
    const first = await start('aprovar-tudo');
    await spawned();
    await host.request('agents.terminalHost.exit', { sessionId: first.sessionId, code: 0 });
    await waitFor(() => states().includes('concluído'));

    commands.length = 0;
    const second = await start('aprovar-tudo');
    await waitFor(() => commands.some((c) => c.type === 'spawn'));
    await host.request('agents.terminalHost.exit', { sessionId: second.sessionId, code: 2 });
    await waitFor(() => states().includes('falhou'));
  });

  it('parar a sessão manda fechar o terminal', async () => {
    await host.request('agents.terminalHost.register', {});
    const { sessionId } = await start('aprovar-tudo');
    await spawned();
    await user.request('agents.stop', { sessionId });
    await waitFor(() => commands.some((c) => c.type === 'stop'));
    expect(commands.find((c) => c.type === 'stop')).toEqual({ type: 'stop', sessionId });
    await waitFor(() => states().includes('parado'));
  });

  it('só quem se registrou como hospedeiro relata; a reconexão perde os terminais que não mantém', async () => {
    await host.request('agents.terminalHost.register', {});
    const { sessionId } = await start('aprovar-tudo');
    await spawned();

    await expect(
      user.request('agents.terminalHost.output', { sessionId, text: 'forjado' }),
    ).rejects.toBeInstanceOf(CoreRpcError);

    // Uma IDE nova se registra sem o terminal: a sessão é dada como perdida.
    const nova = await CoreClient.connect(socket.path, token, 'extension');
    await nova.request('agents.terminalHost.register', { sessions: [] });
    await waitFor(() => states().includes('falhou'));
    nova.close();
  });
});
