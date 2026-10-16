import type { AgentSessionInfo, Decision } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  EventBus,
  HostBridge,
  notificationFor,
  type AgentRuntime,
  type ToHost,
} from '../src/index.js';

function setup(sessions: Pick<AgentSessionInfo, 'sessionId' | 'nome' | 'state'>[] = []): {
  bus: EventBus;
  sent: ToHost[];
} {
  const bus = new EventBus();
  const sent: ToHost[] = [];
  const agents = { list: () => sessions } as unknown as AgentRuntime;
  new HostBridge({ postMessage: (message) => sent.push(message) }, bus, agents);
  return { bus, sent };
}

const decision: Decision = {
  id: 'd1',
  runId: 'r1',
  sessionId: 's1',
  pergunta: 'Seguir com o plano B?',
  opcoes: [{ id: 'sim', rotulo: 'Sim' }],
  criadaEm: '2026-10-15T00:00:00.000Z',
};

describe('HostBridge: decisões do maestro', () => {
  it('leva a decisão pendente ao processo principal como pedido urgente', () => {
    const { bus, sent } = setup([
      { sessionId: 's1', nome: 'Maestro da tarefa', state: 'pensando' },
    ]);
    bus.publish('run.decision', 'r1', decision);
    expect(sent).toEqual([
      {
        type: 'notify',
        sessionId: 's1',
        title: 'Maestro da tarefa pede uma decisão',
        body: 'Seguir com o plano B?',
        urgent: true,
      },
    ]);
  });

  it('sem o agente na lista, o título fala do maestro', () => {
    const { bus, sent } = setup();
    bus.publish('run.decision', 'r1', { ...decision, sessionId: undefined });
    expect(sent).toMatchObject([
      { type: 'notify', title: 'Maestro pede uma decisão', urgent: true },
    ]);
  });

  it('decisão já respondida (autopilot) não avisa', () => {
    const { bus, sent } = setup();
    bus.publish('run.decision', 'r1', { ...decision, escolha: 'sim', origemResposta: 'autopilot' });
    expect(sent).toEqual([]);
    expect(
      notificationFor(
        {
          id: 'x',
          ts: '',
          topic: 'run.decision',
          subject: 'r1',
          data: { ...decision, escolha: 'sim' },
        },
        undefined,
      ),
    ).toBeUndefined();
  });
});
