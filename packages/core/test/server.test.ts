import { stat } from 'node:fs/promises';
import { connect } from 'node:net';

import {
  FaklErrorCode,
  JsonRpcErrorCode,
  type CoreMethod,
  type EventNotificationParams,
  type FaklEvent,
} from '@fakl/protocol';
import { currentLocale, useLocale } from '@fakl/i18n';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CoreClient,
  CoreRpcError,
  createCore,
  createSessionToken,
  RpcError,
  type Core,
} from '../src/index.js';
import { testSocket, waitFor } from './helpers.js';

describe('Core: API local', () => {
  let socket: Awaited<ReturnType<typeof testSocket>>;
  let core: Core;
  let token: string;
  const clients: CoreClient[] = [];

  async function client(): Promise<CoreClient> {
    const c = await CoreClient.connect(socket.path, token, 'test');
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    socket = await testSocket();
    token = createSessionToken();
    core = createCore({ socketPath: socket.path, token });
    await core.start();
  });

  afterEach(async () => {
    useLocale('en');
    for (const c of clients.splice(0)) c.close();
    await core.stop();
    await socket.cleanup();
  });

  it.runIf(process.platform !== 'win32')('cria o socket só com permissão do usuário', async () => {
    expect((await stat(socket.path)).mode & 0o777).toBe(0o600);
  });

  it('guarda a resposta do session.hello', async () => {
    const c = await client();
    expect(c.hello.pid).toBe(process.pid);
    expect(typeof c.hello.coreVersion).toBe('string');
  });

  it('fala no idioma que a IDE informa no session.hello', async () => {
    const ide = await CoreClient.connect(socket.path, token, 'extension', { locale: 'pt-BR' });
    clients.push(ide);
    expect(ide.hello.locale).toBe('pt-br');
    expect(currentLocale()).toBe('pt-br');
    // Outros clientes não mudam o idioma do Core, só o leem.
    const cli = await CoreClient.connect(socket.path, token, 'cli', { locale: 'en' });
    clients.push(cli);
    expect(cli.hello.locale).toBe('pt-br');
    expect(currentLocale()).toBe('pt-br');
  });

  it('avisa quando a conexão cai', async () => {
    const c = await client();
    let closed = 0;
    c.onClose(() => closed++);
    await core.stop();
    await waitFor(() => closed === 1);
    core = createCore({ socketPath: socket.path, token });
    await core.start();
  });

  it('recusa token errado', async () => {
    const error = await CoreClient.connect(socket.path, 'errado', 'test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreRpcError);
    expect((error as CoreRpcError).code).toBe(FaklErrorCode.Unauthorized);
  });

  it('fecha a conexão que não começa com session.hello', async () => {
    const raw = connect(socket.path);
    const received: string[] = [];
    raw.setEncoding('utf8');
    raw.on('data', (chunk: string) => received.push(chunk));
    const closed = new Promise((resolve) => raw.on('close', resolve));
    raw.write('{"jsonrpc":"2.0","id":1,"method":"events.replay","params":{"topics":["*"]}}\n');
    await closed;
    expect(JSON.parse(received.join(''))).toMatchObject({
      id: null,
      error: { code: FaklErrorCode.Unauthorized },
    });
  });

  it('responde métodos desconhecidos e parâmetros inválidos com erros do JSON-RPC', async () => {
    const c = await client();
    await expect(c.request('nada.existe' as CoreMethod, {})).rejects.toMatchObject({
      code: JsonRpcErrorCode.MethodNotFound,
    });
    await expect(c.request('events.subscribe', { topics: [] })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    await expect(c.request('events.subscribe', 'x')).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  it('esconde detalhes de erros inesperados', async () => {
    core.router.register('profiles.list', () => {
      throw new Error('segredo interno');
    });
    core.router.register('profiles.get', () => {
      throw new RpcError(FaklErrorCode.NotFound, 'perfil x não existe', { id: 'x' });
    });
    const c = await client();
    await expect(c.request('profiles.list')).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      message: 'Internal Core error',
    });
    await expect(c.request('profiles.get')).rejects.toMatchObject({
      code: FaklErrorCode.NotFound,
      data: { id: 'x' },
    });
  });

  it('entrega eventos assinados e para depois do unsubscribe', async () => {
    const c = await client();
    const got: EventNotificationParams[] = [];
    c.onNotification((method, params) => {
      if (method === 'events.event') got.push(params as EventNotificationParams);
    });
    const { subscriptionId } = await c.request<{ subscriptionId: string }>('events.subscribe', {
      topics: ['agent.*'],
    });

    core.bus.publish('agent.state', 'ag1', { state: 'pensando' });
    core.bus.publish('run.done', 'run1', {});
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({
      subscriptionId,
      event: { topic: 'agent.state', subject: 'ag1' },
    });

    await c.request('events.unsubscribe', { subscriptionId });
    core.bus.publish('agent.state', 'ag1', {});
    await c.request('events.replay', { topics: ['*'] });
    expect(got).toHaveLength(1);
    await expect(c.request('events.unsubscribe', { subscriptionId })).rejects.toMatchObject({
      code: FaklErrorCode.NotFound,
    });
  });

  it('libera as assinaturas quando o cliente desconecta', async () => {
    // O próprio Core assina alguns tópicos (custos); conta só as do cliente.
    const internal = core.bus.subscriberCount;
    const c = await client();
    await c.request('events.subscribe', { topics: ['*'] });
    expect(core.bus.subscriberCount).toBe(internal + 1);
    c.close();
    await waitFor(() => core.bus.subscriberCount === internal);
  });

  it('reenvia eventos perdidos', async () => {
    const first = core.bus.publish('run.round', 'run1', { n: 1 });
    core.bus.publish('run.round', 'run1', { n: 2 });
    const c = await client();
    const events = await c.request<FaklEvent[]>('events.replay', {
      topics: ['run.*'],
      afterId: first.id,
    });
    expect(events.map((e) => e.data)).toEqual([{ n: 2 }]);
  });

  it('atende vários clientes e pedidos simultâneos', async () => {
    const [a, b] = await Promise.all([client(), client()]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).request<unknown[]>('events.replay', { topics: ['*'] }),
      ),
    );
    expect(results).toHaveLength(20);
    expect(core.server.connectionCount).toBe(2);
  });

  it('rejeita pedidos pendentes quando o Core para', async () => {
    const c = await client();
    await core.stop();
    await expect(c.request('events.replay', { topics: ['*'] })).rejects.toThrow();
  });
});
