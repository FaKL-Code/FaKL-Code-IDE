import type { FaklEvent } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { createUlidFactory, EventBus } from '../src/index.js';

function bus(capacity = 100): EventBus {
  let t = 0;
  return new EventBus(
    capacity,
    createUlidFactory(() => ++t),
    () => new Date(Date.UTC(2026, 9, 11)),
  );
}

describe('EventBus', () => {
  it('entrega só aos assinantes cujos padrões casam', () => {
    const b = bus();
    const agent: FaklEvent[] = [];
    const all: FaklEvent[] = [];
    b.subscribe(['agent.*'], (e) => agent.push(e));
    b.subscribe(['*'], (e) => all.push(e));

    const event = b.publish('agent.state', 'ag1', { state: 'pensando' });
    b.publish('run.done', 'run1', {});

    expect(event).toMatchObject({
      topic: 'agent.state',
      subject: 'ag1',
      ts: '2026-10-11T00:00:00.000Z',
    });
    expect(agent.map((e) => e.topic)).toEqual(['agent.state']);
    expect(all.map((e) => e.topic)).toEqual(['agent.state', 'run.done']);
  });

  it('para de entregar depois do dispose', () => {
    const b = bus();
    const got: string[] = [];
    const sub = b.subscribe(['*'], (e) => got.push(e.topic));
    b.publish('cost.update', 'x', {});
    sub.dispose();
    b.publish('cost.update', 'x', {});
    expect(got).toHaveLength(1);
    expect(b.subscriberCount).toBe(0);
  });

  it('isola assinantes que lançam erro', () => {
    const b = bus();
    const got: string[] = [];
    b.subscribe(['*'], () => {
      throw new Error('quebrado');
    });
    b.subscribe(['*'], (e) => got.push(e.topic));
    b.publish('vault.sync', 'v', {});
    expect(got).toEqual(['vault.sync']);
  });

  it('reenvia o histórico filtrado depois de um id, limitado à capacidade', () => {
    const b = bus(3);
    const ids = ['agent.state', 'run.done', 'agent.output', 'agent.tool'].map(
      (topic) => b.publish(topic as FaklEvent['topic'], 's', {}).id,
    );
    expect(b.replay(['*']).map((e) => e.id)).toEqual(ids.slice(1));
    expect(b.replay(['agent.*'], ids[2]).map((e) => e.topic)).toEqual(['agent.tool']);
    expect(b.replay(['*'], undefined, 1).map((e) => e.id)).toEqual([ids[3]]);
  });
});
