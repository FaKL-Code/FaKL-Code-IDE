import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentState } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AcpAdapter,
  describeToolInput,
  type AgentEvent,
  type AgentHandle,
  type PermissionPolicy,
  type StartOptions,
} from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error('tempo esgotado'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

describe('AcpAdapter', () => {
  let cwd: string;
  const handles: AgentHandle[] = [];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'fakl-agent-'));
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop('usuário');
    await rm(cwd, { recursive: true, force: true });
  });

  const adapter = new AcpAdapter(
    { command: process.execPath, args: [fixture], login: 'faça login no falso' },
    { ...process.env, FAKL_TEST_SECRET: 'vazou' },
  );

  async function start(
    overrides: Partial<StartOptions> & { permissions?: PermissionPolicy } = {},
  ): Promise<{
    handle: AgentHandle;
    events: AgentEvent[];
    states: AgentState[];
    text: () => string;
  }> {
    const handle = await adapter.start({
      profile: { id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' },
      cwd,
      permissions: 'perguntar',
      ...overrides,
    });
    handles.push(handle);
    const events: AgentEvent[] = [];
    handle.onEvent((event) => events.push(event));
    const states = (): AgentState[] => events.flatMap((e) => (e.type === 'state' ? [e.state] : []));
    return {
      handle,
      events,
      get states() {
        return states();
      },
      text: () =>
        events.map((e) => (e.type === 'output' && e.kind === 'message' ? e.text : '')).join(''),
    };
  }

  it('detecta executável presente e ausente', async () => {
    expect((await adapter.detect()).status).toBe('pronto');
    const missing = new AcpAdapter({
      command: 'agente-que-nao-existe',
      args: [],
      install: 'npm i -g agente',
    });
    expect(await missing.detect()).toEqual({ status: 'não-instalado', install: 'npm i -g agente' });
  });

  it('conversa, manda o prompt de sistema só na primeira vez e soma o uso', async () => {
    const agent = await start({ systemPrompt: 'Você é um teste.' });
    expect(agent.handle.state).toBe('ocioso');
    await agent.handle.send('olá');
    await agent.handle.send('olá');
    expect(agent.text()).toBe('oi (2 blocos)oi (1 blocos)');
    expect(agent.states).toEqual(['pensando', 'ocioso', 'pensando', 'ocioso']);
    expect(agent.handle.usage()).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });

  it('repete a vez quando o login falha por outro processo renovando o token', async () => {
    const agent = await start();
    await agent.handle.send('login disputado');
    expect(agent.text()).toContain('entrou na tentativa 2');
  }, 15_000);

  it('estima o uso quando o agente não o informa na resposta', async () => {
    const agent = await start();
    await agent.handle.send('sem uso');
    // 1200 tokens de contexto e "doze caracteres" (15 caracteres, ~4 tokens).
    expect(agent.handle.usage()).toEqual({
      inputTokens: 1200,
      outputTokens: 4,
      totalTokens: 1204,
      context: { used: 1200, size: 200000 },
    });
  });

  it('informa a janela de contexto assim que o agente a manda', async () => {
    const agent = await start();
    await agent.handle.send('sem uso');
    const usages = agent.events.flatMap((event) => (event.type === 'usage' ? [event.usage] : []));
    expect(usages[0]?.context).toEqual({ used: 1200, size: 200000 });
  });

  it('mostra e troca as opções da sessão, como o modelo', async () => {
    const agent = await start();
    expect(agent.handle.sessionOptions()).toEqual([
      {
        id: 'model',
        nome: 'Modelo',
        categoria: 'model',
        atual: 'rapido',
        valores: [
          { id: 'rapido', nome: 'Rápido' },
          { id: 'forte', nome: 'Forte' },
        ],
      },
      { id: 'web', nome: 'Busca na web', atual: false },
    ]);
    await agent.handle.setOption('model', 'forte');
    expect(agent.handle.sessionOptions()[0]?.atual).toBe('forte');
    expect(agent.events).toContainEqual(expect.objectContaining({ type: 'options' }));
    await expect(agent.handle.setOption('model', 'outro')).rejects.toThrow(/outro/);
    await expect(agent.handle.setOption('web', 'sim')).rejects.toThrow(/inválido/);
    await expect(agent.handle.setOption('nada', 'x')).rejects.toThrow(/nada/);
  });

  it('enfileira mensagens mandadas enquanto o agente trabalha', async () => {
    const agent = await start();
    await Promise.all([agent.handle.send('um'), agent.handle.send('dois')]);
    expect(agent.text()).toBe('eco: umeco: dois');
  });

  it('pergunta permissão e repassa a resposta', async () => {
    const agent = await start();
    const done = agent.handle.send('permissão');
    await waitFor(() => agent.events.some((e) => e.type === 'permission'));
    const asked = agent.events.find((e) => e.type === 'permission');
    expect(asked).toMatchObject({
      id: 't1',
      title: 'Editar a.txt',
      detail: 'file_path: a.txt\ncontent: oi\nreplace_all: false',
    });
    expect(agent.handle.state).toBe('aguardando-permissão');
    await agent.handle.respondPermission('t1', false);
    await done;
    expect(agent.text()).toBe('resposta: nao');
    expect(agent.states).toEqual([
      'pensando',
      'executando',
      'aguardando-permissão',
      'pensando',
      'ocioso',
    ]);
  });

  it('com "sempre", escolhe a opção allow_always; sem ela, a avulsa', async () => {
    const always = await start();
    const first = always.handle.send('permissão');
    await waitFor(() => always.events.some((e) => e.type === 'permission'));
    await always.handle.respondPermission('t1', true, true);
    await first;
    expect(always.text()).toBe('resposta: sempre');

    const once = await start();
    const second = once.handle.send('permissão');
    await waitFor(() => once.events.some((e) => e.type === 'permission'));
    await once.handle.respondPermission('t1', true);
    await second;
    expect(once.text()).toBe('resposta: sim');
  });

  it('aprova sozinho com a política aprovar-tudo', async () => {
    const agent = await start({ permissions: 'aprovar-tudo' });
    await agent.handle.send('permissão');
    expect(agent.text()).toBe('resposta: sim');
    expect(agent.events.some((e) => e.type === 'permission')).toBe(false);
  });

  it('lê e grava arquivos só dentro do worktree', async () => {
    const agent = await start();
    await agent.handle.send('escreva pasta/a.txt');
    expect(agent.text()).toBe('li: dois');
    expect(await readFile(join(cwd, 'pasta', 'a.txt'), 'utf8')).toBe('um\ndois\ntrês');
    expect(agent.events).toContainEqual({ type: 'file', path: join('pasta', 'a.txt') });

    await expect(agent.handle.send('fora')).rejects.toThrow(/fora do worktree/);
    expect(agent.handle.state).toBe('ocioso');
  });

  it('não repassa variáveis fora da lista de permissão', async () => {
    const agent = await start();
    await agent.handle.send('segredo');
    expect(agent.text()).toBe('sem segredo');
  });

  it('pausa cancelando a rodada e retoma pedindo para continuar', async () => {
    const agent = await start();
    const slow = agent.handle.send('lento');
    await waitFor(() => agent.handle.state === 'pensando');
    await agent.handle.pause();
    await slow;
    expect(agent.handle.state).toBe('pausado');

    await agent.handle.resume();
    await waitFor(() => agent.text().includes('Continue de onde parou.'));
    await waitFor(() => agent.handle.state === 'ocioso');
    expect(agent.states).toEqual(['pensando', 'pausado', 'ocioso', 'pensando', 'ocioso']);
  });

  it('para o agente e recusa mensagens novas', async () => {
    const agent = await start();
    await agent.handle.stop('usuário');
    expect(agent.events).toContainEqual({
      type: 'state',
      state: 'parado',
      previous: 'ocioso',
      reason: 'usuário',
    });
    await expect(agent.handle.send('olá')).rejects.toThrow(/parado/);
  });

  it('marca falha quando o agente cai, com o fim do stderr', async () => {
    const agent = await start();
    await expect(agent.handle.send('sair')).rejects.toThrow(/código 3.*falha simulada/s);
    expect(agent.handle.state).toBe('falhou');
  });

  it('diz como instalar quando o comando do agente não existe', async () => {
    const missing = new AcpAdapter(
      { command: 'fakl-agente-que-nao-existe', args: [], install: 'npm install -g falso' },
      process.env,
    );
    await expect(
      missing.start({
        profile: { id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' },
        cwd,
        permissions: 'perguntar',
      }),
    ).rejects.toThrow(/não foi encontrado no PATH.*npm install -g falso/);
  });

  it('desiste de um agente que abre mas não responde', async () => {
    const hanging = new AcpAdapter(
      { command: process.execPath, args: [fixture], startTimeoutMs: 700, login: 'faça login' },
      process.env,
    );
    await expect(
      hanging.start({
        profile: { id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' },
        cwd,
        permissions: 'perguntar',
        env: { FAKE_HANG: '1' },
      }),
    ).rejects.toThrow(/não respondeu em 1 s ao iniciar; confira o login \(faça login\)/);
  });

  it('explica quando o agente pede login', async () => {
    await expect(start({ env: { FAKE_AUTH: '1' } })).rejects.toThrow(
      'o agente precisa de login: faça login no falso',
    );
  });
  it('com a chave de API no ambiente, faz o login do ACP por ela', async () => {
    const keyed = new AcpAdapter(
      {
        command: process.execPath,
        args: [fixture],
        keyAuth: { env: 'FAKE_API_KEY', methods: ['fake-api-key'] },
      },
      process.env,
    );
    const handle = await keyed.start({
      profile: { id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' },
      cwd,
      permissions: 'perguntar',
      env: { FAKE_AUTH: '1', FAKE_API_KEY: 'chave-de-teste' },
    });
    handles.push(handle);
    expect(handle.state).toBe('ocioso');
    // Sem a chave, o agente segue pedindo login: a sessão não inventa autenticação.
    await expect(
      keyed.start({
        profile: { id: 'falso', nome: 'Falso', provedor: 'teste', adaptador: 'acp' },
        cwd,
        permissions: 'perguntar',
        env: { FAKE_AUTH: '1' },
      }),
    ).rejects.toThrow('o agente precisa de login');
  });

  describe('retomada de sessão', () => {
    const resume = { sessionId: 's1', history: 'Conversa anterior: oi' };
    const sent = async (handle: AgentHandle, text: string): Promise<void> => {
      await handle.send(text);
    };

    it('carrega a sessão do agente sem reexibir a conversa antiga', async () => {
      const { handle, text } = await start({ env: { FAKE_LOAD: '1' }, resume });
      expect(handle.resumedAs).toBe('sessão');
      expect(handle.remoteSessionId).toBe('s1');
      await sent(handle, 'olá');
      // Sem prompt de sistema nem histórico: o agente já tem a conversa; "ANTIGA" não chegou como evento.
      expect(text()).toBe('oi (1 blocos)');
    });

    it('usa session/resume quando o agente só oferece esse', async () => {
      const { handle } = await start({ env: { FAKE_RESUME: '1' }, resume });
      expect(handle.resumedAs).toBe('sessão');
    });

    it('recria a sessão com o histórico quando o agente não retoma', async () => {
      const { handle, text } = await start({ resume, systemPrompt: 'regras' });
      expect(handle.resumedAs).toBe('histórico');
      await sent(handle, 'olá');
      // Prompt de sistema, histórico e a mensagem.
      expect(text()).toBe('oi (3 blocos)');
    });

    it('cai no histórico quando o agente recusa a sessão antiga', async () => {
      const { handle } = await start({ env: { FAKE_LOAD: '1', FAKE_LOAD_FAIL: '1' }, resume });
      expect(handle.resumedAs).toBe('histórico');
    });
  });
});

describe('describeToolInput', () => {
  it('mostra o comando de uma chamada MCP, um argumento por linha', () => {
    expect(
      describeToolInput({ host: '203.0.113.10', comando: 'uptime; df -h', cwd: '/root' }),
    ).toBe('host: 203.0.113.10\ncomando: uptime; df -h\ncwd: /root');
  });

  it('põe em JSON o que não é texto e pula o vazio', () => {
    expect(describeToolInput({ ids: ['a', 'b'], timeoutSeg: 30, nada: null })).toBe(
      'ids: ["a","b"]\ntimeoutSeg: 30',
    );
    expect(describeToolInput(undefined)).toBeUndefined();
    expect(describeToolInput({})).toBeUndefined();
    expect(describeToolInput('  ls -la ')).toBe('ls -la');
  });

  it('corta argumentos longos', () => {
    const detail = describeToolInput({ conteudo: 'x'.repeat(5_000) });
    expect(detail).toHaveLength(2_001);
    expect(detail?.endsWith('…')).toBe(true);
  });
});
