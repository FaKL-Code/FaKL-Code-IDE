import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExternalSessionsService, Router, type ExternalSessionsOptions } from '../src/index.js';

// Fixtures sintéticas: só reproduzem a forma dos arquivos, sem conversa real.
const NOW = new Date('2026-10-17T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fakl-ext-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function jsonl(...lines: unknown[]): string {
  return `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
}

async function put(file: string, content: string, ageMs: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  const at = new Date(NOW.getTime() - ageMs);
  await utimes(file, at, at);
}

function codexFile(id: string, day = '2026/10/17'): string {
  return join(home, '.codex', 'sessions', day, `rollout-2026-10-17T10-00-00-${id}.jsonl`);
}

function codexMeta(id: string, originator: string, cwd = '/work/app'): unknown {
  return {
    timestamp: '2026-10-17T10:00:00Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { id, cwd, originator, cli_version: '0.0.0', source: 'vscode' },
  };
}

function claudeFile(project: string, id: string): string {
  return join(home, '.claude', 'projects', project, `${id}.jsonl`);
}

function claudeLine(id: string, entrypoint: string, cwd = '/work/web'): unknown {
  return {
    type: 'user',
    sessionId: id,
    uuid: 'u1',
    parentUuid: null,
    isSidechain: false,
    entrypoint,
    cwd,
    version: '0.0.0',
    message: { role: 'user', content: 'texto da mensagem que nunca deve aparecer' },
  };
}

function service(options: Partial<ExternalSessionsOptions> = {}): ExternalSessionsService {
  return new ExternalSessionsService({
    home,
    enabled: () => true,
    clock: () => NOW,
    isAlive: () => true,
    ...options,
  });
}

describe('ExternalSessionsService', () => {
  it('não lê nada sem o consentimento', async () => {
    await put(codexFile('c1'), jsonl(codexMeta('c1', 'codex_vscode')), MINUTE);
    const result = await service({ enabled: () => false }).list();
    expect(result).toEqual({ ativo: false, sessoes: [] });
  });

  it('lista as conversas da extensão do Codex e deixa de fora as do Core', async () => {
    await put(codexFile('c1'), jsonl(codexMeta('c1', 'codex_vscode', '/work/app')), 10 * MINUTE);
    await put(codexFile('c2'), jsonl(codexMeta('c2', 'fakl-code')), MINUTE);
    await put(codexFile('c3'), jsonl(codexMeta('c3', 'codex_cli_rs')), MINUTE);
    await put(
      join(home, '.codex', 'session_index.jsonl'),
      jsonl(
        { id: 'c1', thread_name: 'primeiro nome', updated_at: '2026-10-17T10:00:00Z' },
        { id: 'c1', thread_name: 'Ajustar o login', updated_at: '2026-10-17T10:05:00Z' },
        { id: 'c2', thread_name: 'do Core' },
      ),
      MINUTE,
    );
    const { sessoes } = await service().list();
    expect(sessoes).toEqual([
      {
        id: 'codex:c1',
        fonte: 'codex',
        sessionId: 'c1',
        provedor: 'openai',
        titulo: 'Ajustar o login',
        pasta: '/work/app',
        estado: 'parada',
        atualizadaEm: new Date(NOW.getTime() - 10 * MINUTE).toISOString(),
      },
    ]);
  });

  it('marca como ativa a conversa do Codex que mexeu há pouco', async () => {
    await put(codexFile('c1'), jsonl(codexMeta('c1', 'codex_vscode')), 30_000);
    const { sessoes } = await service().list();
    expect(sessoes[0]?.estado).toBe('ativa');
    expect(sessoes[0]?.titulo).toBeUndefined();
  });

  it('lista as conversas da extensão do Claude e deixa de fora as do Core', async () => {
    await put(
      claudeFile('proj-a', 's1'),
      jsonl(
        { type: 'queue-operation', operation: 'enqueue' },
        claudeLine('s1', 'claude-vscode', '/work/web'),
        { type: 'custom-title', customTitle: 'Primeiro', sessionId: 's1' },
        { type: 'custom-title', customTitle: 'Refatorar o menu', sessionId: 's1' },
      ),
      20 * MINUTE,
    );
    await put(claudeFile('proj-a', 's2'), jsonl(claudeLine('s2', 'sdk-ts')), MINUTE);
    await put(claudeFile('proj-a', 's3'), jsonl(claudeLine('s3', 'cli')), MINUTE);
    await put(claudeFile('proj-a', 's4'), jsonl(claudeLine('s4', 'claude-desktop')), MINUTE);
    const { sessoes } = await service().list();
    expect(sessoes).toEqual([
      {
        id: 'claude-code:s1',
        fonte: 'claude-code',
        sessionId: 's1',
        provedor: 'anthropic',
        titulo: 'Refatorar o menu',
        pasta: '/work/web',
        estado: 'parada',
        atualizadaEm: new Date(NOW.getTime() - 20 * MINUTE).toISOString(),
      },
    ]);
  });

  it('usa o status da sessão viva do Claude e o nome dela', async () => {
    await put(claudeFile('p', 's1'), jsonl(claudeLine('s1', 'claude-vscode')), 30 * MINUTE);
    await put(claudeFile('p', 's2'), jsonl(claudeLine('s2', 'claude-vscode')), 30 * MINUTE);
    await put(
      join(home, '.claude', 'sessions', '101.json'),
      JSON.stringify({ pid: 101, sessionId: 's1', status: 'busy', name: 'Em andamento' }),
      MINUTE,
    );
    await put(
      join(home, '.claude', 'sessions', '102.json'),
      JSON.stringify({ pid: 102, sessionId: 's2', status: 'busy', name: 'Processo morto' }),
      MINUTE,
    );
    const { sessoes } = await service({ isAlive: (pid) => pid === 101 }).list();
    const byId = new Map(sessoes.map((s) => [s.sessionId, s]));
    expect(byId.get('s1')).toMatchObject({ estado: 'ativa', titulo: 'Em andamento' });
    expect(byId.get('s2')).toMatchObject({ estado: 'parada' });
    expect(byId.get('s2')?.titulo).toBeUndefined();
  });

  it('ignora linhas corrompidas e campos inesperados sem falhar', async () => {
    await put(
      codexFile('c1'),
      jsonl('isto nao e json', '{"cortado":', '[1,2]', 'null', codexMeta('c1', 'codex_vscode')),
      MINUTE,
    );
    await put(codexFile('c2'), '', MINUTE);
    await put(
      codexFile('c3'),
      jsonl({ type: 'session_meta', payload: 'estranho' }, { type: 'session_meta' }),
      MINUTE,
    );
    await put(
      codexFile('c4'),
      jsonl({ type: 'session_meta', payload: { id: 7, cwd: null, originator: 'codex_vscode' } }),
      MINUTE,
    );
    await put(
      claudeFile('p', 'bad1'),
      jsonl(
        '{"quebrado',
        { entrypoint: 42, cwd: {}, sessionId: [] },
        { type: 'custom-title', customTitle: 9 },
      ),
      MINUTE,
    );
    await put(claudeFile('p', 'bad2'), '\u0000\u0001 binário\n', MINUTE);
    await put(
      claudeFile('p', 'ok'),
      jsonl(
        'lixo',
        claudeLine('ok', 'claude-vscode'),
        { type: 'custom-title', customTitle: ['x'] },
        '{"type":',
      ),
      MINUTE,
    );
    await put(join(home, '.codex', 'session_index.jsonl'), 'lixo\n{"id":1}\n{"id":"c1"}\n', MINUTE);
    await put(join(home, '.claude', 'sessions', '5.json'), '{nao-json', MINUTE);
    await put(join(home, '.claude', 'sessions', '6.json'), '[]', MINUTE);
    const { sessoes } = await service().list();
    expect(sessoes.map((s) => s.id).sort()).toEqual(['claude-code:ok', 'codex:c1']);
  });

  it('devolve lista vazia quando as pastas das ferramentas não existem', async () => {
    expect(await service().list()).toEqual({ ativo: true, sessoes: [] });
  });

  it('esconde as conversas antigas', async () => {
    await put(codexFile('old', '2026/10/01'), jsonl(codexMeta('old', 'codex_vscode')), 16 * DAY);
    await put(claudeFile('p', 'old'), jsonl(claudeLine('old', 'claude-vscode')), 8 * DAY);
    await put(claudeFile('p', 'new'), jsonl(claudeLine('new', 'claude-vscode')), 6 * DAY);
    const { sessoes } = await service().list();
    expect(sessoes.map((s) => s.id)).toEqual(['claude-code:new']);
  });

  it('acha o começo da conversa do Codex mesmo com instruções enormes na primeira linha', async () => {
    const meta = codexMeta('big', 'codex_vscode') as { payload: Record<string, unknown> };
    meta.payload.instructions = 'x'.repeat(300_000);
    await put(codexFile('big'), jsonl(meta), MINUTE);
    const { sessoes } = await service().list();
    expect(sessoes.map((s) => s.sessionId)).toEqual(['big']);
  });

  it('tira segredos do título e da pasta e não mostra o texto das mensagens', async () => {
    await put(
      claudeFile('p', 's1'),
      jsonl(claudeLine('s1', 'claude-vscode', '/work/SEGREDO-pasta'), {
        type: 'custom-title',
        customTitle: 'usar SEGREDO-chave no deploy',
      }),
      MINUTE,
    );
    const { sessoes } = await service({
      redact: (text) => text.replaceAll(/SEGREDO-\w+/g, '[removido]'),
    }).list();
    expect(sessoes[0]?.titulo).toBe('usar [removido] no deploy');
    expect(sessoes[0]?.pasta).toBe('/work/[removido]');
    expect(JSON.stringify(sessoes)).not.toContain('texto da mensagem');
  });

  it('ordena pela atividade mais recente, de qualquer ferramenta', async () => {
    await put(codexFile('c1'), jsonl(codexMeta('c1', 'codex_vscode')), 30 * MINUTE);
    await put(claudeFile('p', 's1'), jsonl(claudeLine('s1', 'claude-vscode')), 5 * MINUTE);
    const { sessoes } = await service().list();
    expect(sessoes.map((s) => s.id)).toEqual(['claude-code:s1', 'codex:c1']);
  });

  it('nunca grava nos arquivos que lê', async () => {
    const file = claudeFile('p', 's1');
    const content = jsonl(claudeLine('s1', 'claude-vscode'));
    await put(file, content, MINUTE);
    const before = await stat(file);
    await service().list();
    const after = await stat(file);
    expect(await readFile(file, 'utf8')).toBe(content);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('respeita CODEX_HOME e CLAUDE_CONFIG_DIR', async () => {
    const codex = join(home, 'outro-codex');
    const claude = join(home, 'outro-claude');
    await put(
      join(codex, 'sessions', '2026', '10', '17', 'rollout-x-c9.jsonl'),
      jsonl(codexMeta('c9', 'codex_vscode')),
      MINUTE,
    );
    await put(
      join(claude, 'projects', 'p', 's9.jsonl'),
      jsonl(claudeLine('s9', 'claude-vscode')),
      MINUTE,
    );
    const { sessoes } = await service({
      env: { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude },
    }).list();
    expect(sessoes.map((s) => s.id).sort()).toEqual(['claude-code:s9', 'codex:c9']);
  });
});

describe('external.* no roteador', () => {
  it('liga e desliga o consentimento pelo RPC', async () => {
    let enabled = false;
    const router = new Router();
    service({
      enabled: () => enabled,
      save: (value) => {
        enabled = value;
        return Promise.resolve();
      },
    }).register(router);
    const call = (method: string, params?: unknown): Promise<unknown> =>
      router.dispatch(method, params, {
        connectionId: 'c',
        onClose: () => undefined,
      } as never);
    expect(await call('external.status')).toEqual({ ativo: false });
    expect(await call('external.setEnabled', { ativo: true })).toEqual({ ativo: true });
    expect(await call('external.list')).toMatchObject({ ativo: true });
    await expect(call('external.setEnabled', { ativo: 'sim' })).rejects.toThrow();
  });
});
