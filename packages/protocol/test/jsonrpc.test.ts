import { describe, expect, it } from 'vitest';

import {
  FaklErrorCode,
  JsonRpcErrorCode,
  failure,
  isFailure,
  isNotification,
  isRequest,
  isResponse,
  success,
} from '../src/index.js';

describe('jsonrpc', () => {
  it('reconhece requisições com id', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'runs.start' })).toBe(true);
    expect(isRequest({ jsonrpc: '2.0', id: 'a', method: 'runs.start', params: {} })).toBe(true);
  });

  it('rejeita mensagens fora do formato', () => {
    expect(isRequest({ jsonrpc: '1.0', id: 1, method: 'x' })).toBe(false);
    expect(isRequest({ jsonrpc: '2.0', id: {}, method: 'x' })).toBe(false);
    expect(isRequest({ jsonrpc: '2.0', id: Number.NaN, method: 'x' })).toBe(false);
    expect(isRequest(null)).toBe(false);
    expect(isRequest([])).toBe(false);
  });

  it('distingue notificação de requisição', () => {
    const notification = { jsonrpc: '2.0', method: 'events.subscribe' };
    expect(isNotification(notification)).toBe(true);
    expect(isRequest(notification)).toBe(false);
    expect(isNotification({ ...notification, id: 1 })).toBe(false);
  });

  it('constrói e reconhece respostas de sucesso', () => {
    const response = success(7, { ok: true });
    expect(response).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(isResponse(response)).toBe(true);
    expect(isFailure(response)).toBe(false);
  });

  it('constrói e reconhece respostas de erro, com e sem dados', () => {
    const plain = failure(1, JsonRpcErrorCode.MethodNotFound, 'método desconhecido');
    expect(plain.error).toEqual({ code: -32601, message: 'método desconhecido' });
    expect(isResponse(plain)).toBe(true);
    expect(isFailure(plain)).toBe(true);

    const withData = failure(null, FaklErrorCode.LimitExceeded, 'limite', { limit: 'rodadas' });
    expect(withData.error.data).toEqual({ limit: 'rodadas' });
    expect(isResponse(withData)).toBe(true);
  });

  it('rejeita respostas ambíguas ou incompletas', () => {
    expect(isResponse({ jsonrpc: '2.0', id: 1 })).toBe(false);
    expect(isResponse({ jsonrpc: '2.0', id: 1, result: 1, error: {} })).toBe(false);
    expect(isResponse({ jsonrpc: '2.0', id: null, result: 1 })).toBe(false);
    expect(isResponse({ jsonrpc: '2.0', id: 1, error: { code: 'x', message: 'y' } })).toBe(false);
    expect(isResponse({ jsonrpc: '2.0', id: 1, method: 'x', result: 1 })).toBe(false);
  });

  it('mantém os códigos do Core na faixa reservada a servidores', () => {
    for (const code of Object.values(FaklErrorCode)) {
      expect(code).toBeLessThanOrEqual(-32000);
      expect(code).toBeGreaterThanOrEqual(-32099);
    }
  });
});
