import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProfileEntry, FaklEvent } from '@fakl/protocol';
import { providerProfiles } from '@fakl/agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  ConfigStore,
  CoreClient,
  CoreRpcError,
  EventBus,
  composePrompt,
  focusRule,
  createCore,
  createSessionToken,
  parseConfig,
  parseProfile,
  worktreeRule,
} from '../src/index.js';
import { testSocket, waitFor } from './helpers.js';

describe('parseProfile', () => {
  it('aceita um perfil completo', () => {
    const profile = parseProfile(
      {
        id: 'revisor',
        nome: 'Revisor',
        provedor: 'anthropic',
        modelo: 'claude-opus',
        pontosFortes: ['revisão'],
        custoRelativo: 'alto',
        regras: ['nunca faça push'],
        podeSerMaestro: true,
      },
      'revisor.yaml',
    );
    expect(profile).toMatchObject({ id: 'revisor', adaptador: 'acp', custoRelativo: 'alto' });
  });

  it('aceita perfis de modelo local com endereço', () => {
    const raw = { id: 'qwen', nome: 'Qwen', provedor: 'ollama', adaptador: 'ollama' };
    expect(parseProfile({ ...raw, endpoint: 'http://pc:11434/v1' }, 'a')).toMatchObject({
      adaptador: 'ollama',
      endpoint: 'http://pc:11434/v1',
    });
    expect(() => parseProfile({ ...raw, endpoint: 'pc:11434' }, 'a')).toThrow(/endpoint/);
    expect(() => parseProfile({ ...raw, adaptador: 'pty' }, 'a')).toThrow(/adaptador/);
  });

  it('aceita perfis de agente de terminal e valida comando, prompt e silêncio', () => {
    const raw = {
      id: 'aider',
      nome: 'Aider',
      provedor: 'aider',
      adaptador: 'terminal',
      comando: 'aider',
      terminal: { prompt: '^>$', silencioSegundos: 4 },
    };
    expect(parseProfile(raw, 'a')).toMatchObject({
      adaptador: 'terminal',
      comando: 'aider',
      terminal: { prompt: '^>$', silencioSegundos: 4 },
    });
    expect(() => parseProfile({ ...raw, comando: undefined }, 'a')).toThrow(/comando/);
    expect(() => parseProfile({ ...raw, terminal: { prompt: '(' } }, 'a')).toThrow(
      /expressão regular/,
    );
    expect(() => parseProfile({ ...raw, terminal: { silencioSegundos: 0 } }, 'a')).toThrow(
      /silencioSegundos/,
    );
    expect(() => parseProfile({ ...raw, terminal: 'x' }, 'a')).toThrow(/terminal/);
  });

  it('aceita o modo de permissão do perfil, inclusive autopilot', () => {
    const raw = { id: 'qwen', nome: 'Qwen', provedor: 'ollama', adaptador: 'ollama' };
    expect(parseProfile({ ...raw, permissoes: 'autopilot' }, 'a').permissoes).toBe('autopilot');
    expect(() => parseProfile({ ...raw, permissoes: 'tudo' }, 'a')).toThrow(/permissoes/);
    expect(parseConfig({ permissoes: 'autopilot' }, 'c').permissoes).toBe('autopilot');
  });

  it('mantém as conversas das extensões desligadas até o consentimento', () => {
    expect(parseConfig({}, 'c').sessoesExternas).toBeUndefined();
    expect(parseConfig({ sessoesExternas: 'sim' }, 'c').sessoesExternas).toBeUndefined();
    expect(parseConfig({ sessoesExternas: true }, 'c').sessoesExternas).toBe(true);
  });

  it('recusa id inválido, campo faltando e tipos errados', () => {
    expect(() => parseProfile({ id: 'Com Espaço', nome: 'x', provedor: 'y' }, 'a')).toThrow(
      ConfigError,
    );
    expect(() => parseProfile({ id: 'x', provedor: 'y' }, 'a')).toThrow(/nome/);
    expect(() => parseProfile({ id: 'x', nome: 'x', provedor: 'y', regras: 'uma' }, 'a')).toThrow(
      /regras/,
    );
    expect(() =>
      parseProfile({ id: 'x', nome: 'x', provedor: 'y', custoRelativo: 'grátis' }, 'a'),
    ).toThrow(/custoRelativo/);
  });
});

describe('parseConfig', () => {
  it('usa o padrão quando o arquivo está vazio', () => {
    expect(parseConfig(null, 'c')).toEqual({
      mcpServers: [],
      permissoes: 'perguntar',
      tetoDiario: {},
    });
  });

  it('lê servidores MCP e a política padrão', () => {
    const config = parseConfig(
      {
        mcpServers: [{ nome: 'arquivos', comando: 'npx', args: ['-y', 'srv'], env: { A: '1' } }],
        permissoes: 'aprovar-leitura',
      },
      'c',
    );
    expect(config.mcpServers[0]).toEqual({
      nome: 'arquivos',
      comando: 'npx',
      args: ['-y', 'srv'],
      env: { A: '1' },
    });
    expect(config.permissoes).toBe('aprovar-leitura');
    expect(() => parseConfig({ mcpServers: [{ nome: 'x' }] }, 'c')).toThrow(/comando/);
    expect(() => parseConfig({ permissoes: 'tudo' }, 'c')).toThrow(/permissoes/);
  });

  it('lê o build pós-merge, que é opcional', () => {
    expect(parseConfig({}, 'c').buildAposMerge).toBeUndefined();
    expect(
      parseConfig(
        { buildAposMerge: { workflow: 'build.yml', inputs: { plataformas: 'windows', n: 2 } } },
        'c',
      ).buildAposMerge,
    ).toEqual({ workflow: 'build.yml', inputs: { plataformas: 'windows', n: '2' } });
    expect(parseConfig({ buildAposMerge: { workflow: 'ci.yaml' } }, 'c').buildAposMerge).toEqual({
      workflow: 'ci.yaml',
    });
    expect(() => parseConfig({ buildAposMerge: { workflow: '../x.yml' } }, 'c')).toThrow(
      /workflow/,
    );
    expect(() =>
      parseConfig({ buildAposMerge: { workflow: 'build.yml', inputs: [] } }, 'c'),
    ).toThrow(/inputs/);
  });
});

describe('composePrompt', () => {
  it('põe as regras do perfil antes do contexto', () => {
    const profile = { id: 'a', nome: 'A', provedor: 'x', adaptador: 'acp' as const };
    expect(composePrompt(profile)).toBe(focusRule());
    expect(composePrompt({ ...profile, regras: ['r1', 'r2'] }, 'tarefa')).toBe(
      `${focusRule()}\n\nRegras para este trabalho:\n- r1\n- r2\n\ntarefa`,
    );
  });

  it('diz ao agente no worktree que a pasta do usuário não é dele', () => {
    const profile = { id: 'a', nome: 'A', provedor: 'x', adaptador: 'acp' as const };
    const tree = { path: '/w/s1', branch: 'fakl/avulso/s1', repoRoot: '/repo', base: 'abc' };
    const solo = worktreeRule(tree);
    expect(solo).toContain('/w/s1, no branch fakl/avulso/s1');
    expect(solo).toContain('A pasta /repo é a cópia de trabalho do usuário');
    expect(solo).toContain('Não use git stash');
    expect(solo).toContain('abra um PR');
    expect(worktreeRule(tree, true)).toContain('não faça push nem abra PR');
    expect(composePrompt(profile, 'tarefa', { tree, inTask: false })).toBe(
      `${focusRule()}\n\n${solo}\n\ntarefa`,
    );
  });
});

describe('ConfigStore', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-config-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('sem provedor pronto, a primeira abertura não cria perfil e o config.yaml fica genérico', async () => {
    const store = new ConfigStore({ home });
    await store.load();
    expect(store.profiles).toEqual([]);
    expect(await readdir(store.profilesDir)).toEqual([]);
    const text = await readFile(store.configFile, 'utf8');
    expect(text).toMatch(/mcpServers/);
    expect(text).toContain('perfilEscalada: <id de um perfil mais forte>');
    expect(text).toContain('#   <provedor>: { custoUsd: 20 }');
    expect(text).not.toMatch(/anthropic|claude|codex|gemini/);
  });

  it('cria só os perfis que a primeira abertura pede e cita o que existe', async () => {
    let calls = 0;
    const store: ConfigStore = new ConfigStore({
      home,
      firstRun: async () => {
        calls++;
        const gemini = providerProfiles().google;
        for (const profile of gemini) await store.createProfile(profile);
        return { provedores: ['google'], perfis: gemini };
      },
    });
    await store.load();
    expect(store.profiles.map((p) => p.id)).toEqual(['gemini']);
    const text = await readFile(store.configFile, 'utf8');
    expect(text).toContain('perfilEscalada: gemini');
    expect(text).toContain('#   google: { custoUsd: 20 }');
    expect(text).not.toContain('<provedor>');
    await store.load();
    expect(calls).toBe(1);
  });

  it('não sobrescreve nem recria perfis do usuário', async () => {
    const store = new ConfigStore({ home });
    await store.load();
    await writeFile(
      join(store.profilesDir, 'claude.yaml'),
      'id: claude\nnome: Meu\nprovedor: anthropic\n',
    );
    await store.load();
    const [claude] = providerProfiles().anthropic;
    if (!claude) throw new Error('sem perfil de fábrica do Claude');
    expect(await store.createProfile({ ...claude, nome: 'Outro' })).toBe(false);
    await store.load();
    expect(store.profile('claude')?.nome).toBe('Meu');
    await store.remove('claude');
    await store.load();
    expect(store.profiles).toEqual([]);
  });

  it('pula arquivo inválido e informa o erro', async () => {
    const store = new ConfigStore({ home });
    await store.load();
    await writeFile(join(store.profilesDir, 'a.yaml'), 'id: claude\nnome: X\nprovedor: y\n');
    await writeFile(join(store.profilesDir, 'ruim.yaml'), 'id: [quebrado');
    await writeFile(join(store.profilesDir, 'dup.yaml'), 'id: claude\nnome: X\nprovedor: y\n');
    await store.load();
    expect(store.profiles.map((p) => p.id)).toEqual(['claude']);
    expect(store.errors).toHaveLength(2);
  });

  it('lê env e chaveEnv de um agente ACP cadastrado', () => {
    const raw = { id: 'opencode', nome: 'OpenCode', provedor: 'opencode', comando: 'opencode' };
    expect(
      parseProfile({ ...raw, env: { A: '1' }, chaveEnv: 'OPENROUTER_API_KEY' }, 'a'),
    ).toMatchObject({ env: { A: '1' }, chaveEnv: 'OPENROUTER_API_KEY' });
    expect(() => parseProfile({ ...raw, env: { A: 1 } }, 'a')).toThrow(/env/);
    expect(() => parseProfile({ ...raw, chaveEnv: 'com espaço' }, 'a')).toThrow(/chaveEnv/);
  });

  it('relê ao mudar um arquivo e publica config.changed', async () => {
    const bus = new EventBus();
    const events: FaklEvent[] = [];
    bus.subscribe(['config.changed'], (event) => events.push(event));
    const store = new ConfigStore({ home, bus });
    await store.load();
    store.watch();
    try {
      await writeFile(
        join(store.profilesDir, 'novo.yaml'),
        'id: novo\nnome: Novo\nprovedor: google\nmodelo: gemini-pro\n',
      );
      await waitFor(() => store.profile('novo') !== undefined, 3_000);
      expect(store.profile('novo')?.modelo).toBe('gemini-pro');
      await waitFor(() => events.length > 0, 3_000);
    } finally {
      store.dispose();
    }
  });
});

describe('Core: perfis pela API', () => {
  it('lista, grava e apaga perfis', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fakl-config-core-'));
    const socket = await testSocket();
    const token = createSessionToken();
    const core = createCore({ socketPath: socket.path, token, configHome: home });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    try {
      // Nenhum provedor nesta máquina de teste: a IDE abre sem perfil nenhum.
      const listed = await client.request<AgentProfileEntry[]>('profiles.list');
      expect(listed).toEqual([]);

      const saved = await client.request<AgentProfileEntry>('profiles.upsert', {
        profile: { id: 'barato', nome: 'Barato', provedor: 'google', custoRelativo: 'baixo' },
      });
      expect(saved.arquivo).toBe(join(home, '.fakl', 'profiles', 'barato.yaml'));
      const detected = await client.request<{ id: string }[]>('agents.detect');
      expect(detected.map((p) => p.id)).toContain('barato');

      await expect(
        client.request('profiles.upsert', { profile: { id: 'x', nome: 'X' } }),
      ).rejects.toBeInstanceOf(CoreRpcError);

      await client.request('profiles.delete', { id: 'barato' });
      await expect(client.request('profiles.get', { id: 'barato' })).rejects.toBeInstanceOf(
        CoreRpcError,
      );
    } finally {
      client.close();
      await core.stop();
      await socket.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('lê e muda a política de permissão padrão, mantendo os comentários', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fakl-config-core-'));
    const socket = await testSocket();
    const token = createSessionToken();
    const core = createCore({ socketPath: socket.path, token, configHome: home });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    const file = join(home, '.fakl', 'config.yaml');
    try {
      expect(await client.request('config.permissions.get')).toEqual({ permissoes: 'perguntar' });
      expect(
        await client.request('config.permissions.set', { permissoes: 'aprovar-leitura' }),
      ).toEqual({ permissoes: 'aprovar-leitura' });
      const text = await readFile(file, 'utf8');
      expect(text).toMatch(/^permissoes: aprovar-leitura$/m);
      expect(text).toMatch(/^# Configuração do FaKL-Code/);

      // Voltar ao padrão tira a chave do arquivo.
      await client.request('config.permissions.set', { permissoes: 'perguntar' });
      expect(await readFile(file, 'utf8')).not.toMatch(/^permissoes:/m);
      await expect(
        client.request('config.permissions.set', { permissoes: 'tudo' }),
      ).rejects.toBeInstanceOf(CoreRpcError);
    } finally {
      client.close();
      await core.stop();
      await socket.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});
