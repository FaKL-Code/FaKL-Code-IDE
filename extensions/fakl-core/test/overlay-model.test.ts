import { describe, expect, it } from 'vitest';

import { revealSession } from '../src/overlay-model.js';

describe('revealSession', () => {
  it('devolve o agente do evento ui.reveal', () => {
    expect(revealSession({ topic: 'ui.reveal', data: { sessionId: 'abc' } })).toBe('abc');
  });

  it('sem agente, só traz a IDE', () => {
    expect(revealSession({ topic: 'ui.reveal', data: {} })).toBeUndefined();
    expect(revealSession({ topic: 'ui.reveal', data: { sessionId: '' } })).toBeUndefined();
    expect(revealSession({ topic: 'ui.reveal', data: { sessionId: 3 } })).toBeUndefined();
  });

  it('ignora outros tópicos', () => {
    expect(revealSession({ topic: 'agent.state', data: { sessionId: 'abc' } })).toBeUndefined();
  });
});
