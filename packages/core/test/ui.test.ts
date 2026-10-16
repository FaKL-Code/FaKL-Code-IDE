import type { FaklEvent } from '@fakl/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoreClient, createCore, createSessionToken, type ToHost } from '../src/index.js';
import { REVEAL_TTL_MS } from '../src/ui.js';
import { testSocket, waitFor } from './helpers.js';

describe('Core: ui.reveal e ui.overlay', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function start(): Promise<{
    client: CoreClient;
    sent: ToHost[];
    events: FaklEvent[];
  }> {
    const socket = await testSocket();
    const token = createSessionToken();
    const sent: ToHost[] = [];
    const core = createCore({
      socketPath: socket.path,
      token,
      host: { postMessage: (message) => sent.push(message) },
    });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    cleanups.push(async () => {
      client.close();
      await core.stop();
      await socket.cleanup();
    });
    const events: FaklEvent[] = [];
    core.bus.subscribe(['ui.reveal'], (event) => events.push(event));
    return { client, sent, events };
  }

  it('ui.reveal publica o evento e avisa o processo principal', async () => {
    const { client, sent, events } = await start();
    await client.request('ui.reveal', { sessionId: 'abc' });
    await client.request('ui.reveal');
    await waitFor(() => events.length === 2);
    expect(events.map((e) => [e.subject, e.data])).toEqual([
      ['abc', { sessionId: 'abc' }],
      ['ide', {}],
    ]);
    expect(sent).toEqual([{ type: 'reveal' }, { type: 'reveal' }]);
  });

  it('ui.takeReveal entrega a conversa pedida uma vez, a quem conectar depois', async () => {
    const { client } = await start();
    expect(await client.request('ui.takeReveal')).toBeNull();
    await client.request('ui.reveal', { sessionId: 'abc' });
    // Outra janela respondendo ao evento com outra conversa não leva esta.
    expect(await client.request('ui.takeReveal', { sessionId: 'xyz' })).toBeNull();
    expect(await client.request('ui.takeReveal')).toEqual({ sessionId: 'abc' });
    expect(await client.request('ui.takeReveal')).toBeNull();
  });

  it('ui.reveal sem agente descarta a conversa pendente', async () => {
    const { client } = await start();
    await client.request('ui.reveal', { sessionId: 'abc' });
    await client.request('ui.reveal');
    expect(await client.request('ui.takeReveal')).toBeNull();
  });

  it('a conversa pendente expira', async () => {
    const { client } = await start();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await client.request('ui.reveal', { sessionId: 'abc' });
      vi.setSystemTime(Date.now() + REVEAL_TTL_MS + 1);
      expect(await client.request('ui.takeReveal', { sessionId: 'abc' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ui.overlay repassa a ação e o minimizeIde', async () => {
    const { client, sent } = await start();
    await client.request('ui.overlay', { action: 'show', minimizeIde: true });
    await client.request('ui.overlay', { action: 'toggle' });
    expect(sent).toEqual([
      { type: 'overlay', action: 'show', minimizeIde: true },
      { type: 'overlay', action: 'toggle', minimizeIde: false },
    ]);
  });

  it('recusa parâmetros inválidos', async () => {
    const { client, sent } = await start();
    await expect(client.request('ui.overlay', { action: 'explodir' })).rejects.toThrow();
    await expect(
      client.request('ui.overlay', { action: 'show', minimizeIde: 'sim' }),
    ).rejects.toThrow();
    await expect(client.request('ui.reveal', { sessionId: 3 })).rejects.toThrow();
    await expect(client.request('ui.takeReveal', { sessionId: '' })).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  it('não vale para tokens de agentes nem para o celular', async () => {
    const { TOOL_SETS } = await import('../src/mcp/tools.js');
    const { methodsForScopes, REMOTE_SCOPES } = await import('@fakl/remote');
    const agentMethods = Object.values(TOOL_SETS).flatMap((tools) => tools.map((t) => t.method));
    expect(agentMethods.some((m) => m.startsWith('ui.'))).toBe(false);
    expect([...methodsForScopes([...REMOTE_SCOPES])].some((m) => m.startsWith('ui.'))).toBe(false);
  });
});
