import { describe, expect, it } from 'vitest';

import {
  AcpAdapter,
  adapterForProfile,
  commandForProfile,
  defaultProfiles,
  keyAuthMethod,
  LocalAdapter,
  localProfile,
  pickLocalModel,
  providerCommands,
  providerProfiles,
} from '../src/index.js';

function acp(adapter: unknown): AcpAdapter {
  expect(adapter).toBeInstanceOf(AcpAdapter);
  return adapter as AcpAdapter;
}

function defaultProfile(id: string) {
  const profile = defaultProfiles().find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`perfil padrão ${id} não encontrado`);
  return profile;
}

describe('adapterForProfile', () => {
  it('usa o agente ACP padrão de cada provedor', () => {
    const commands = defaultProfiles().map((profile) => {
      const { command, args } = acp(adapterForProfile(profile)).command;
      return [profile.id, command, args];
    });
    expect(commands).toEqual([
      ['claude', 'claude-agent-acp', []],
      ['claude-haiku', 'claude-agent-acp', []],
      ['claude-sonnet', 'claude-agent-acp', []],
      ['claude-opus', 'claude-agent-acp', []],
      ['codex', 'codex-acp', []],
      ['codex-luna', 'codex-acp', ['-c', 'model="gpt-6-luna"']],
      ['gemini', 'gemini', ['--acp']],
    ]);
  });

  it('oferece perfis padrão com especialidades, modelo e custo', () => {
    expect(
      defaultProfiles().map(({ id, modelo, custoRelativo, podeSerMaestro }) => ({
        id,
        modelo,
        custoRelativo,
        podeSerMaestro,
      })),
    ).toEqual([
      { id: 'claude', modelo: undefined, custoRelativo: 'médio', podeSerMaestro: undefined },
      {
        id: 'claude-haiku',
        modelo: 'claude-haiku-5-5',
        custoRelativo: 'baixo',
        podeSerMaestro: undefined,
      },
      {
        id: 'claude-sonnet',
        modelo: 'claude-sonnet-5-5',
        custoRelativo: 'médio',
        podeSerMaestro: true,
      },
      {
        id: 'claude-opus',
        modelo: 'claude-opus-5-5',
        custoRelativo: 'alto',
        podeSerMaestro: true,
      },
      { id: 'codex', modelo: undefined, custoRelativo: 'médio', podeSerMaestro: true },
      { id: 'codex-luna', modelo: 'gpt-6-luna', custoRelativo: 'baixo', podeSerMaestro: undefined },
      { id: 'gemini', modelo: undefined, custoRelativo: 'baixo', podeSerMaestro: true },
    ]);
    for (const profile of defaultProfiles()) {
      expect(profile.pontosFortes?.length).toBeGreaterThanOrEqual(3);
      expect(profile.pontosFortes?.length).toBeLessThanOrEqual(5);
    }
  });

  it('roda qualquer agente ACP quando o perfil informa o comando', () => {
    const adapter = adapterForProfile({
      id: 'meu',
      nome: 'Meu agente',
      provedor: 'outro',
      adaptador: 'acp',
      comando: 'meu-agente',
      args: ['--acp'],
    });
    expect(acp(adapter).command).toEqual({ command: 'meu-agente', args: ['--acp'] });
  });

  it('roda um agente ACP cadastrado com env e a variável da chave', () => {
    const command = commandForProfile({
      id: 'opencode',
      nome: 'OpenCode',
      provedor: 'opencode',
      adaptador: 'acp',
      comando: 'opencode',
      args: ['acp'],
      env: { OPENCODE_THEME: 'escuro' },
      chaveEnv: 'OPENROUTER_API_KEY',
    });
    expect(command).toEqual({
      command: 'opencode',
      args: ['acp'],
      env: { OPENCODE_THEME: 'escuro' },
      install: 'npm install -g opencode-ai',
      keyAuth: { env: 'OPENROUTER_API_KEY', methods: [] },
    });
  });

  it('separa os perfis de fábrica por provedor', () => {
    expect(Object.keys(providerProfiles())).toEqual(['anthropic', 'openai', 'google']);
    for (const [provedor, profiles] of Object.entries(providerProfiles())) {
      expect(profiles.every((profile) => profile.provedor === provedor)).toBe(true);
      // Sozinho na máquina, todo provedor tem um perfil que pode ser maestro.
      expect(profiles.some((profile) => profile.podeSerMaestro)).toBe(true);
    }
  });

  it('escolhe o modelo local de programar e ignora embeddings', () => {
    expect(pickLocalModel(['nomic-embed-text', 'llama3.2', 'qwen2.5-coder:7b'])).toBe(
      'qwen2.5-coder:7b',
    );
    expect(pickLocalModel(['nomic-embed-text', 'phi4'])).toBe('phi4');
    expect(pickLocalModel(['nomic-embed-text'])).toBeUndefined();
    expect(localProfile('lmstudio', 'qwen3')).toMatchObject({
      id: 'lmstudio',
      provedor: 'lmstudio',
      adaptador: 'ollama',
      modelo: 'qwen3',
    });
  });

  it('usa o adaptador local para perfis ollama', () => {
    const adapter = adapterForProfile({
      id: 'local',
      nome: 'Local',
      provedor: 'ollama',
      adaptador: 'ollama',
      modelo: 'qwen2.5-coder',
    });
    expect(adapter).toBeInstanceOf(LocalAdapter);
    expect(adapter.id).toBe('ollama');
  });

  it('recusa provedor sem padrão e sem comando', () => {
    expect(() =>
      adapterForProfile({ id: 'x', nome: 'X', provedor: 'outro', adaptador: 'acp' }),
    ).toThrow(/informe o comando/);
  });

  it('pede o modelo do perfil do jeito de cada CLI', () => {
    const claude = commandForProfile({ ...defaultProfile('claude'), modelo: 'm-1' });
    const codex = commandForProfile({ ...defaultProfile('codex'), modelo: 'm-1' });
    const gemini = commandForProfile({ ...defaultProfile('gemini'), modelo: 'm-1' });
    expect(claude.env).toEqual({ ANTHROPIC_MODEL: 'm-1' });
    expect(codex.args).toEqual(['-c', 'model="m-1"']);
    expect(gemini.args).toEqual(['--acp', '--model', 'm-1']);
    expect(commandForProfile(defaultProfile('claude-haiku')).env).toEqual({
      ANTHROPIC_MODEL: 'claude-haiku-5-5',
    });
  });
});

describe('keyAuthMethod', () => {
  const methods = [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }];

  it('pede o login pela chave só quando a sessão recebeu a chave', () => {
    const gemini = providerCommands().google;
    expect(keyAuthMethod(gemini, { GEMINI_API_KEY: 'k' }, methods)).toBe('gemini-api-key');
    // Sem chave, vale o login da assinatura que o CLI já tem.
    expect(keyAuthMethod(gemini, {}, methods)).toBeUndefined();
    expect(keyAuthMethod(gemini, undefined, methods)).toBeUndefined();
  });

  it('não inventa método que o agente não anuncia', () => {
    expect(
      keyAuthMethod(providerCommands().openai, { OPENAI_API_KEY: 'k' }, [{ id: 'chatgpt' }]),
    ).toBeUndefined();
    expect(
      keyAuthMethod(providerCommands().openai, { OPENAI_API_KEY: 'k' }, [
        { id: 'chatgpt' },
        { id: 'openai-api-key' },
      ]),
    ).toBe('openai-api-key');
    // O Claude Code lê ANTHROPIC_API_KEY sozinho.
    expect(
      keyAuthMethod(providerCommands().anthropic, { ANTHROPIC_API_KEY: 'k' }, methods),
    ).toBeUndefined();
  });
});
