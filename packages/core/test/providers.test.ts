import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { AgentAdapter, AgentProfile, StartOptions } from '@fakl/agents';
import {
  apiKeySecretName,
  type AgentProfileEntry,
  type ProvidersDetectResult,
  type ProvidersGenerateResult,
  type ProviderStatus,
  type Task,
} from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigStore,
  CoreClient,
  createCore,
  createSessionToken,
  isNewer,
  npmLatestVersion,
  parseVersion,
  providerKeyEnv,
  ProviderService,
  type CliRunner,
  type ProviderServiceOptions,
} from '../src/index.js';
import { testSocket } from './helpers.js';

const win = process.platform === 'win32';

/** Uma máquina de mentira: pasta pessoal, PATH com os executáveis pedidos e servidores locais. */
interface Machine {
  readonly home: string;
  readonly bin: string;
  readonly env: Record<string, string>;
  install(...commands: string[]): Promise<void>;
  file(path: string, content: string): Promise<void>;
}

async function machine(root: string): Promise<Machine> {
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  return {
    home,
    bin,
    env: { PATH: bin, ...(win ? { PATHEXT: '.CMD' } : {}) },
    async install(...commands) {
      for (const command of commands) {
        const file = join(bin, win ? `${command}.cmd` : command);
        await writeFile(file, win ? '@echo off\r\n' : '#!/bin/sh\n');
        if (!win) await chmod(file, 0o755);
      }
    },
    async file(path, content) {
      const full = join(home, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content);
    },
  };
}

/** Servidores locais que respondem com estes modelos; os demais estão fechados. */
function localServers(models: Partial<Record<'ollama' | 'lmstudio', string[]>>) {
  return (input: string): Promise<Response> => {
    const port = input.includes(':11434') ? 'ollama' : input.includes(':1234') ? 'lmstudio' : '';
    const list = port ? models[port] : undefined;
    if (!list) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(
      new Response(JSON.stringify({ data: list.map((id) => ({ id })) }), { status: 200 }),
    );
  };
}

const versions: CliRunner = (file, args) =>
  Promise.resolve(
    args[0] === '--version'
      ? { code: 0, stdout: `${String(file.split(/[\\/]/).pop())} 1.2.3 (teste)\n` }
      : { code: 1, stdout: '' },
  );

describe('ProviderService', () => {
  let root: string;
  let m: Machine;
  let store: ConfigStore;
  let keys: Set<string>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-providers-'));
    m = await machine(root);
    store = new ConfigStore({ home: m.home });
    await store.load();
    keys = new Set();
  });

  afterEach(async () => {
    store.dispose();
    await rm(root, { recursive: true, force: true });
  });

  function service(
    fetchModels: Partial<Record<'ollama' | 'lmstudio', string[]>> = {},
    env: Record<string, string> = {},
    extra: Partial<ProviderServiceOptions> = {},
  ): ProviderService {
    return new ProviderService({
      profiles: () => store.profiles,
      createProfile: (profile) => store.createProfile(profile),
      reload: () => store.load(),
      hasKey: (provedor) => keys.has(provedor),
      env: { ...m.env, ...env },
      home: m.home,
      stateFile: join(store.dir, 'data', 'providers.json'),
      runCli: versions,
      fetch: localServers(fetchModels),
      ...extra,
    });
  }

  const byId = (list: readonly ProviderStatus[], id: string): ProviderStatus => {
    const found = list.find((status) => status.id === id);
    if (!found) throw new Error(`sem ${id}`);
    return found;
  };
  const ready = (list: readonly ProviderStatus[]): string[] =>
    list.filter((status) => status.pronto).map((status) => `${status.id}:${String(status.modo)}`);
  const ids = (): string[] => store.profiles.map((profile) => profile.id).sort();

  it('nenhum provedor: nada pronto, nenhum perfil e o caminho para cada um', async () => {
    const providers = service();
    const list = await providers.detect();
    expect(ready(list)).toEqual([]);
    expect(list.map((status) => status.id)).toEqual([
      'anthropic',
      'openai',
      'google',
      'ollama',
      'lmstudio',
    ]);
    const claude = byId(list, 'anthropic');
    expect(claude).toMatchObject({
      instalado: false,
      logado: false,
      chave: false,
      chaveEnv: 'ANTHROPIC_API_KEY',
      login: 'claude auth login',
    });
    expect(claude.instalar).toBe(
      'npm install -g @agentclientprotocol/claude-agent-acp && npm install -g @anthropic-ai/claude-code',
    );
    expect(byId(list, 'ollama').aviso).toContain('nenhum servidor');
    expect((await providers.generateProfiles()).criados).toEqual([]);
    expect(store.profiles).toEqual([]);
  });

  it('só Claude por assinatura: perfis só do Claude', async () => {
    await m.install('claude-agent-acp', 'claude');
    await m.file('.claude/.credentials.json', '{}');
    const providers = service();
    const list = await providers.detect({ versions: true });
    expect(ready(list)).toEqual(['anthropic:assinatura']);
    expect(byId(list, 'anthropic').versao).toBe('1.2.3');
    const { criados } = await providers.generateProfiles();
    expect([...criados].sort()).toEqual(['claude', 'claude-haiku', 'claude-opus', 'claude-sonnet']);
    expect(ids()).toEqual(['claude', 'claude-haiku', 'claude-opus', 'claude-sonnet']);
  });

  it('compara adaptador e CLI com a última versão do npm, só quando pedido', async () => {
    await m.install('codex-acp', 'codex', 'claude-agent-acp');
    const asked: string[] = [];
    const latest: Record<string, string> = {
      '@agentclientprotocol/codex-acp': '2.0.0',
      '@openai/codex': '1.2.3',
    };
    const providers = service(
      {},
      {},
      {
        latestVersion: (pacote) => {
          asked.push(pacote);
          return Promise.resolve(latest[pacote]);
        },
      },
    );
    const plain = await providers.detect({ versions: true });
    expect(byId(plain, 'openai').atualizacoes).toBeUndefined();
    expect(asked).toEqual([]);

    const list = await providers.detect({ versions: true, updates: true });
    expect(byId(list, 'openai').atualizacoes).toEqual([
      {
        pacote: '@agentclientprotocol/codex-acp',
        comando: 'codex-acp',
        papel: 'adaptador',
        instalada: '1.2.3',
        ultima: '2.0.0',
        desatualizada: true,
        atualizar: 'npm install -g @agentclientprotocol/codex-acp@latest',
      },
      {
        pacote: '@openai/codex',
        comando: 'codex',
        papel: 'cli',
        instalada: '1.2.3',
        ultima: '1.2.3',
        desatualizada: false,
        atualizar: 'npm install -g @openai/codex@latest',
      },
    ]);
    // Sem resposta do npm (offline) ou sem o executável, nada é afirmado.
    expect(byId(list, 'anthropic').atualizacoes).toBeUndefined();
    expect(byId(list, 'google').atualizacoes).toBeUndefined();
    expect(asked).not.toContain('@google/gemini-cli');
  });

  it('versões: compara major.minor.patch e ignora pré-lançamento', () => {
    expect(isNewer('2.10.0', '2.9.9')).toBe(true);
    expect(isNewer('0.93.0', '0.89.1')).toBe(true);
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('1.2.3', '1.2.3-alpha.4')).toBe(false);
    expect(isNewer('1.2', '1.2.1')).toBe(false);
  });

  it('npm: lê a versão, guarda por uma hora e devolve vazio quando falha', async () => {
    let calls = 0;
    const urls: string[] = [];
    const ok = (input: string): Promise<Response> => {
      calls++;
      urls.push(input);
      return Promise.resolve(new Response(JSON.stringify({ version: '3.4.5' }), { status: 200 }));
    };
    expect(await npmLatestVersion('@scope/pacote-teste', ok)).toBe('3.4.5');
    expect(await npmLatestVersion('@scope/pacote-teste', ok)).toBe('3.4.5');
    expect(calls).toBe(1);
    expect(urls).toEqual(['https://registry.npmjs.org/@scope/pacote-teste/latest']);
    const fail = (): Promise<Response> => Promise.reject(new Error('ENOTFOUND'));
    expect(await npmLatestVersion('pacote-offline', fail)).toBeUndefined();
    const odd = (): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify({ version: 'latest' }), { status: 200 }));
    expect(await npmLatestVersion('pacote-estranho', odd)).toBeUndefined();
    const missing = (): Promise<Response> => Promise.resolve(new Response('', { status: 404 }));
    expect(await npmLatestVersion('pacote-inexistente', missing)).toBeUndefined();
  });

  it('só Codex por assinatura', async () => {
    await m.install('codex-acp', 'codex');
    await m.file('.codex/auth.json', JSON.stringify({ tokens: { access_token: 'x' } }));
    const providers = service();
    expect(ready(await providers.detect())).toEqual(['openai:assinatura']);
    await providers.generateProfiles();
    expect(ids()).toEqual(['codex', 'codex-luna']);
  });

  it('só Gemini por assinatura, com perfil que pode ser maestro', async () => {
    await m.install('gemini');
    await m.file('.gemini/oauth_creds.json', '{}');
    const providers = service();
    const list = await providers.detect();
    expect(ready(list)).toEqual(['google:assinatura']);
    // O CLI do Gemini é o próprio agente: não pede um segundo pacote.
    expect(byId(list, 'google').instalar).toBeUndefined();
    await providers.generateProfiles();
    expect(store.profiles.map((profile) => [profile.id, profile.podeSerMaestro])).toEqual([
      ['gemini', true],
    ]);
  });

  it('só modelo local: um perfil com o modelo de programar do servidor', async () => {
    const providers = service({ ollama: ['nomic-embed-text', 'qwen2.5-coder:7b'] });
    const list = await providers.detect();
    expect(ready(list)).toEqual(['ollama:local']);
    expect(byId(list, 'ollama').modelos).toEqual(['nomic-embed-text', 'qwen2.5-coder:7b']);
    expect(byId(list, 'lmstudio').pronto).toBe(false);
    await providers.generateProfiles();
    expect(store.profiles).toEqual([
      expect.objectContaining({
        id: 'ollama',
        provedor: 'ollama',
        adaptador: 'ollama',
        modelo: 'qwen2.5-coder:7b',
      }),
    ]);
  });

  it('servidor local só com embeddings não vira perfil', async () => {
    const providers = service({ lmstudio: ['nomic-embed-text'] });
    const lm = byId(await providers.detect(), 'lmstudio');
    expect(lm).toMatchObject({ instalado: true, pronto: false });
    expect(lm.aviso).toContain('baixe um modelo');
  });

  it('só chave de API: pronto sem login, no modo chave', async () => {
    await m.install('codex-acp');
    keys.add('openai');
    const providers = service();
    const list = await providers.detect();
    expect(ready(list)).toEqual(['openai:chave']);
    // Com chave, o CLI de login não faz falta.
    expect(byId(list, 'openai').instalar).toBeUndefined();
    await providers.generateProfiles();
    expect(ids()).toEqual(['codex', 'codex-luna']);
  });

  it('chave só no ambiente do shell não vale, mas a detecção avisa', async () => {
    await m.install('claude-agent-acp');
    const providers = service({}, { ANTHROPIC_API_KEY: 'do-shell' });
    const claude = byId(await providers.detect(), 'anthropic');
    expect(claude.pronto).toBe(false);
    expect(claude.aviso).toContain('ANTHROPIC_API_KEY no ambiente');
    expect(claude.aviso).not.toContain('do-shell');
  });

  it('o diagnóstico: o CLI oficial é visto à parte do adaptador', async () => {
    await m.install('claude-agent-acp');
    const claude = byId(await service().detect(), 'anthropic');
    expect(claude.instalado).toBe(true);
    expect(claude.cliInstalado).toBe(false);
    await m.install('claude');
    expect(byId(await service().detect(), 'anthropic').cliInstalado).toBe(true);
    // No Gemini o adaptador é o próprio CLI.
    await m.install('gemini');
    expect(byId(await service().detect(), 'google').cliInstalado).toBe(true);
  });

  it('o diagnóstico: o tipo de login do Gemini vem do settings, sem ler o OAuth', async () => {
    await m.install('gemini');
    expect(byId(await service().detect(), 'google').loginTipo).toBeUndefined();
    // Só o arquivo de OAuth (conteúdo qualquer): vale o padrão do CLI, conta pessoal.
    await m.file('.gemini/oauth_creds.json', 'nao-e-lido');
    expect(byId(await service().detect(), 'google').loginTipo).toBe('oauth-personal');
    await m.file(
      '.gemini/settings.json',
      JSON.stringify({ security: { auth: { selectedType: 'vertex-ai' } } }),
    );
    expect(byId(await service().detect(), 'google').loginTipo).toBe('vertex-ai');
    await m.file('.gemini/settings.json', JSON.stringify({ selectedAuthType: 'gemini-api-key' }));
    expect(byId(await service().detect(), 'google').loginTipo).toBe('gemini-api-key');
    // Só o Gemini tem esse campo.
    expect(byId(await service().detect(), 'anthropic').loginTipo).toBeUndefined();
  });

  it('o diagnóstico: Node, npm e chaves só no ambiente', async () => {
    const none = await service().environment();
    expect(none).toEqual({ chavesNoAmbiente: [] });

    await m.install('node', 'npm');
    const runCli: CliRunner = (file) =>
      Promise.resolve({
        code: 0,
        stdout: basename(file).startsWith('node') ? 'v22.13.0' : '10.9.2',
      });
    const env = { GEMINI_API_KEY: 'do-shell', OPENAI_API_KEY: 'outra' };
    keys.add('openai');
    const found = await service({}, env, { runCli }).environment();
    expect(found).toEqual({ node: '22.13.0', npm: '10.9.2', chavesNoAmbiente: ['google'] });
    expect(JSON.stringify(found)).not.toContain('do-shell');
  });

  it('dois provedores: Claude por chave e Gemini por assinatura', async () => {
    await m.install('claude-agent-acp', 'gemini');
    await m.file('.gemini/oauth_creds.json', '{}');
    keys.add('anthropic');
    const providers = service();
    expect(ready(await providers.detect())).toEqual(['anthropic:chave', 'google:assinatura']);
    await providers.generateProfiles();
    expect(ids()).toEqual(['claude', 'claude-haiku', 'claude-opus', 'claude-sonnet', 'gemini']);
  });

  it('instalado sem login nem chave: não pronto, com o comando de login', async () => {
    await m.install('codex-acp', 'codex');
    const openai = byId(await service().detect(), 'openai');
    expect(openai).toMatchObject({ instalado: true, logado: false, pronto: false });
    expect(openai.aviso).toContain('codex login');
  });

  it('nunca sobrescreve perfis e não recria o que o usuário apagou', async () => {
    await m.install('gemini');
    await m.file('.gemini/oauth_creds.json', '{}');
    await writeFile(
      join(store.profilesDir, 'gemini.yaml'),
      'id: gemini\nnome: Meu Gemini\nprovedor: google\n',
    );
    await store.load();
    const providers = service();
    expect((await providers.generateProfiles()).criados).toEqual([]);
    expect(store.profile('gemini')?.nome).toBe('Meu Gemini');

    await store.remove('gemini');
    await store.load();
    // Primeira geração do provedor: grava e lembra.
    expect((await providers.generateProfiles()).criados).toEqual(['gemini']);
    await store.remove('gemini');
    await store.load();
    expect((await service().generateProfiles()).criados).toEqual([]);
    // Pedido explícito (jornada de configuração, chave nova) manda.
    expect((await service().generateProfiles(['google'])).criados).toEqual(['gemini']);
  });

  it('cadastra um agente ACP de terceiros como provedor', async () => {
    const providers = service();
    const profile = await providers.addAcp({
      id: 'opencode',
      nome: 'OpenCode',
      comando: 'opencode',
      args: ['acp'],
      chaveEnv: 'OPENROUTER_API_KEY',
    });
    expect(profile).toMatchObject({ provedor: 'opencode', podeSerMaestro: true });
    let acp = byId(await providers.detect(), 'opencode');
    expect(acp).toMatchObject({
      tipo: 'acp',
      instalado: false,
      pronto: false,
      instalar: 'npm install -g opencode-ai',
      chaveEnv: 'OPENROUTER_API_KEY',
      perfis: ['opencode'],
    });
    await m.install('opencode');
    acp = byId(await providers.detect(), 'opencode');
    expect(acp).toMatchObject({ instalado: true, pronto: true, modo: 'acp' });
    expect(ready(await providers.detect())).toEqual(['opencode:acp']);
    await expect(providers.addAcp({ id: 'opencode', nome: 'x', comando: 'y' })).rejects.toThrow(
      /já existe/,
    );
    await expect(providers.addAcp({ id: 'anthropic', nome: 'x', comando: 'y' })).rejects.toThrow(
      /já é um provedor/,
    );
  });
});

describe('providerKeyEnv', () => {
  const vault = new Map<string, string>([
    [apiKeySecretName('anthropic'), 'chave-a'],
    [apiKeySecretName('opencode'), 'chave-o'],
  ]);
  const get = (name: string): string | undefined => vault.get(name);
  const profile = (provedor: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({
    id: provedor,
    nome: provedor,
    provedor,
    adaptador: 'acp',
    ...extra,
  });

  it('entrega a chave só ao agente do provedor dela', () => {
    expect(providerKeyEnv(profile('anthropic'), get)).toEqual({ ANTHROPIC_API_KEY: 'chave-a' });
    expect(providerKeyEnv(profile('openai'), get)).toEqual({});
    expect(providerKeyEnv(profile('google'), get)).toEqual({});
    expect(providerKeyEnv(profile('opencode', { chaveEnv: 'OPENROUTER_API_KEY' }), get)).toEqual({
      OPENROUTER_API_KEY: 'chave-o',
    });
    // Agente ACP sem variável declarada: a chave não vai a lugar nenhum.
    expect(providerKeyEnv(profile('opencode'), get)).toEqual({});
  });

  it('lê a versão da saída do CLI', () => {
    expect(parseVersion('2.1.3 (Claude Code)')).toBe('2.1.3');
    expect(parseVersion('codex-cli 0.98.0')).toBe('0.98.0');
    expect(parseVersion('0.64.0-preview.1')).toBe('0.64.0-preview.1');
    expect(parseVersion('sem versão')).toBeUndefined();
  });
});

describe('Core: maestro sem provedor', () => {
  it('recusa a execução com uma mensagem que diz como ligar um provedor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fakl-providers-maestro-'));
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo });
    };
    git('config', 'user.name', 'Teste');
    git('config', 'user.email', 'teste@exemplo.com');
    await writeFile(join(repo, 'README.md'), 'oi\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'inicial');
    const socket = await testSocket();
    const token = createSessionToken();
    const core = createCore({
      socketPath: socket.path,
      token,
      configHome: join(root, 'home'),
      env: {},
      mcp: { command: 'fakl-mcp-inexistente', args: [] },
    });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    try {
      const task = await client.request<Task>('tasks.create', { titulo: 'X', repoPath: repo });
      await expect(client.request('runs.start', { taskId: task.id })).rejects.toThrow(
        /nenhum está configurado.*chave de API.*modelo local.*agente ACP/,
      );
    } finally {
      client.close();
      await core.stop();
      await socket.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Core: provedores pela API', () => {
  it('detecta, gera perfis e só injeta a chave no agente do provedor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fakl-providers-core-'));
    const socket = await testSocket();
    const token = createSessionToken();
    const started: StartOptions[] = [];
    const recorder: AgentAdapter = {
      id: 'acp',
      detect: () => Promise.resolve({ status: 'pronto' }),
      start: (options) => {
        started.push(options);
        return Promise.reject(new Error('agente de teste'));
      },
    };
    const core = createCore({
      socketPath: socket.path,
      token,
      configHome: root,
      env: {},
      agents: { adapterFor: () => recorder },
    });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    try {
      const detected = await client.request<ProvidersDetectResult>('providers.detect');
      expect(detected.provedores.filter((status) => status.pronto)).toEqual([]);

      await client.request('providers.acp.add', {
        id: 'meu-acp',
        nome: 'Meu ACP',
        comando: 'meu-acp',
        chaveEnv: 'MEU_TOKEN',
      });
      await client.request('profiles.upsert', {
        profile: { id: 'claude', nome: 'Claude', provedor: 'anthropic' },
      });
      await client.request('secrets.set', { nome: 'apikey.anthropic', valor: 'sk-teste' });
      await client.request('secrets.set', { nome: 'apikey.meu-acp', valor: 'tok-teste' });
      await expect(
        client.request('secrets.set', { nome: 'apikey.Inválido', valor: 'x' }),
      ).rejects.toThrow(/segredo desconhecido/);

      for (const profileId of ['claude', 'meu-acp']) {
        await client.request('agents.start', { profileId, cwd: root }).catch(() => undefined);
      }
      expect(started.map((options) => [options.profile.id, options.env])).toEqual([
        ['claude', expect.objectContaining({ ANTHROPIC_API_KEY: 'sk-teste' })],
        ['meu-acp', expect.objectContaining({ MEU_TOKEN: 'tok-teste' })],
      ]);
      expect(started[0]?.env).not.toHaveProperty('MEU_TOKEN');
      expect(started[1]?.env).not.toHaveProperty('ANTHROPIC_API_KEY');

      const generated = await client.request<ProvidersGenerateResult>('providers.generateProfiles');
      expect(generated.criados).toEqual([]);
      const profiles = await client.request<AgentProfileEntry[]>('profiles.list');
      expect(profiles.map((entry) => entry.profile.id).sort()).toEqual(['claude', 'meu-acp']);
    } finally {
      client.close();
      await core.stop();
      await socket.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
