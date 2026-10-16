import type { FaklEvent } from '@fakl/protocol';
import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OverlayBridge, OverlayStatus } from '../src/bridge.js';
import { CoreClient, CoreError, TOPICS } from '../src/rpc.js';

/** Ponte de teste: guarda o que o cliente manda e deixa o teste responder. */
class FakeBridge implements Pick<OverlayBridge, 'send' | 'onFrame' | 'onStatus'> {
  readonly sent: { id: number; method: string; params?: unknown }[] = [];
  private frame: (frame: string) => void = () => undefined;
  private status: (status: OverlayStatus) => void = () => undefined;

  send(frame: string): void {
    this.sent.push(JSON.parse(frame) as { id: number; method: string; params?: unknown });
  }

  onFrame(listener: (frame: string) => void): void {
    this.frame = listener;
  }

  onStatus(listener: (status: OverlayStatus) => void): void {
    this.status = listener;
  }

  setStatus(status: OverlayStatus): void {
    this.status(status);
  }

  push(message: unknown): void {
    this.frame(typeof message === 'string' ? message : JSON.stringify(message));
  }

  reply(id: number, result: unknown): void {
    this.push({ jsonrpc: '2.0', id, result });
  }

  last(method: string): { id: number; method: string; params?: unknown } | undefined {
    return this.sent.findLast((m) => m.method === method);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function online(bridge: FakeBridge, client: CoreClient): Promise<void> {
  bridge.setStatus('online');
  const subscribe = bridge.last('events.subscribe');
  if (subscribe) bridge.reply(subscribe.id, { subscriptionId: 'x' });
  await tick();
  expect(client.status).toBe('online');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cliente do Core', () => {
  it('falha na hora sem conexão, sem mandar nada', async () => {
    const bridge = new FakeBridge();
    const client = new CoreClient(bridge);
    expect(client.status).toBe('conectando');
    await expect(client.call('agents.list')).rejects.toBeInstanceOf(CoreError);
    expect(bridge.sent).toEqual([]);
  });

  it('assina os tópicos ao ficar online, sem session.hello, e avisa depois', async () => {
    const bridge = new FakeBridge();
    const client = new CoreClient(bridge);
    const statuses: string[] = [];
    client.onStatus((status) => statuses.push(status));
    bridge.setStatus('online');
    expect(bridge.sent.map((m) => m.method)).toEqual(['events.subscribe']);
    expect(bridge.sent[0]?.params).toEqual({ topics: TOPICS });
    expect(statuses).toEqual([]);
    bridge.reply(bridge.sent[0]?.id ?? 0, {});
    await tick();
    expect(statuses).toEqual(['online']);
    expect(TOPICS).toEqual(['agent.*', 'run.*', 'cost.update', 'claude.*']);
  });

  it('casa respostas pelos ids, inclusive fora de ordem e com erro', async () => {
    const bridge = new FakeBridge();
    const client = new CoreClient(bridge);
    await online(bridge, client);
    const a = client.call<string>('agents.list');
    const b = client.call('agents.stop', { sessionId: 's1' });
    const [first, second] = bridge.sent.slice(-2);
    expect(first?.id).not.toBe(second?.id);
    expect(second?.params).toEqual({ sessionId: 's1' });
    bridge.push({ jsonrpc: '2.0', id: second?.id, error: { code: -32003, message: 'Não existe' } });
    bridge.reply(first?.id ?? 0, 'lista');
    await expect(a).resolves.toBe('lista');
    await expect(b).rejects.toMatchObject({ message: 'Não existe', code: -32003 });
  });

  it('entrega os eventos e ignora frames estranhos', () => {
    const bridge = new FakeBridge();
    const client = new CoreClient(bridge);
    const events: FaklEvent[] = [];
    client.onEvent((event) => events.push(event));
    const event: FaklEvent = { id: '1', ts: '', topic: 'agent.state', subject: 's1', data: {} };
    bridge.push('não é json');
    bridge.push({ jsonrpc: '2.0', method: 'outra.coisa', params: {} });
    bridge.push({ jsonrpc: '2.0', id: 999, result: null });
    bridge.push({ jsonrpc: '2.0', method: 'events.event', params: { subscriptionId: 'x', event } });
    expect(events).toEqual([event]);
  });

  it('ao cair, rejeita o que estava pendente; ao voltar, assina de novo', async () => {
    const bridge = new FakeBridge();
    const client = new CoreClient(bridge);
    await online(bridge, client);
    const pending = client.call('agents.list');
    bridge.setStatus('offline');
    await expect(pending).rejects.toThrow('The connection to the Core dropped.');
    expect(client.status).toBe('offline');
    await online(bridge, client);
    expect(bridge.sent.filter((m) => m.method === 'events.subscribe')).toHaveLength(2);
  });

  it('desiste de um pedido sem resposta', async () => {
    vi.useFakeTimers();
    const bridge = new FakeBridge();
    const client = new CoreClient(bridge);
    bridge.setStatus('online');
    bridge.reply(bridge.sent[0]?.id ?? 0, {});
    await vi.advanceTimersByTimeAsync(0);
    const call = client.call('agents.list');
    const check = expect(call).rejects.toThrow("The Core didn't answer agents.list.");
    await vi.advanceTimersByTimeAsync(30_000);
    await check;
  });

  it('em pt-BR, os erros da conexão em português', async () => {
    useLocale('pt-br');
    try {
      const bridge = new FakeBridge();
      const client = new CoreClient(bridge);
      await expect(client.call('agents.list')).rejects.toThrow('Sem conexão com o Core.');
      await online(bridge, client);
      const pending = client.call('agents.list');
      bridge.setStatus('offline');
      await expect(pending).rejects.toThrow('A conexão com o Core caiu.');
    } finally {
      useLocale('en');
    }
  });
});
