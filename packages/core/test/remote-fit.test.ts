import { FaklErrorCode } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { fitForRelay, MAX_REMOTE_MESSAGE_BYTES } from '../src/remote/gateway.js';

describe('fitForRelay', () => {
  it('deixa passar o que cabe num quadro do relay', () => {
    const reply = { jsonrpc: '2.0', id: 1, result: { ok: true } };
    expect(fitForRelay(reply)).toBe(reply);
  });

  it('troca a resposta grande demais por um erro, sem derrubar o canal', () => {
    const big = 'x'.repeat(MAX_REMOTE_MESSAGE_BYTES);
    expect(fitForRelay({ jsonrpc: '2.0', id: 7, result: big })).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: { code: FaklErrorCode.LimitExceeded },
    });
  });

  it('descarta a notificação grande demais', () => {
    const big = 'é'.repeat(MAX_REMOTE_MESSAGE_BYTES / 2);
    expect(fitForRelay({ jsonrpc: '2.0', method: 'events.event', params: big })).toBeUndefined();
  });
});
