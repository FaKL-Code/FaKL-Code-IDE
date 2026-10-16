import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSessionStore, migrateRecord, type StoredSession } from '../src/agent-store.js';

describe('store: tarefa e retomada', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-store-recovery-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const base: StoredSession = {
    versao: 1,
    id: 'a',
    profileId: 'p',
    nome: 'P',
    cwd: '/x',
    estado: 'parado',
    permissoes: 'perguntar',
    opcoes: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    criadoEm: '2020-01-01T00:00:00Z',
    atualizadoEm: '2020-01-01T00:00:00Z',
  };

  it('mantém campos opcionais antigos compatíveis e preserva taskId/retomada válidos', () => {
    expect(migrateRecord(base)).not.toHaveProperty('retomada');
    expect(
      migrateRecord({
        ...base,
        taskId: 'task',
        retomada: { motivo: 'limite-sessao', mensagem: 'limit', automatica: true },
        retomadaAutomatica: true,
      }),
    ).toMatchObject({ taskId: 'task', retomada: { automatica: true }, retomadaAutomatica: true });
  });

  it('descarta campos novos inválidos sem perder sessão antiga', () => {
    const record = migrateRecord({
      ...base,
      taskId: 5,
      retomada: { motivo: 'other', automatica: 'yes' },
      retomadaAutomatica: 'yes',
    });
    expect(record).not.toHaveProperty('taskId');
    expect(record).not.toHaveProperty('retomada');
    expect(record).not.toHaveProperty('retomadaAutomatica');
  });

  it('retenção não apaga tarefa nem sessão aguardando renovação', async () => {
    const store = new AgentSessionStore({ dir });
    await store.save(base);
    await store.save({ ...base, id: 'task', taskId: 'task-1' });
    await store.save({
      ...base,
      id: 'limit',
      retomada: { motivo: 'limite-sessao', mensagem: 'limit', automatica: false },
    });
    expect((await store.load()).map((r) => r.id).sort()).toEqual(['limit', 'task']);
  });
});
