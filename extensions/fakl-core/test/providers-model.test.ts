import { useLocale } from '@fakl/i18n';
import type { ProviderStatus } from '@fakl/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fixCommands,
  keyTargets,
  outdated,
  parseArgs,
  parseEnvPairs,
  statusLine,
} from '../src/providers-model.js';

const status = (extra: Partial<ProviderStatus>): ProviderStatus => ({
  id: 'openai',
  nome: 'Codex',
  tipo: 'cli',
  instalado: false,
  chave: false,
  pronto: false,
  perfis: [],
  ...extra,
});

describe('provedores na extensão', () => {
  afterEach(() => useLocale('en'));

  it('oferece chave para os três provedores e os agentes ACP que declararam a variável', () => {
    expect(
      keyTargets([
        status({ id: 'opencode', nome: 'OpenCode', tipo: 'acp', chaveEnv: 'OPENROUTER_API_KEY' }),
        status({ id: 'qwen', nome: 'Qwen Code', tipo: 'acp' }),
      ]),
    ).toEqual([
      { id: 'anthropic', nome: 'Claude', variavel: 'ANTHROPIC_API_KEY' },
      { id: 'openai', nome: 'Codex', variavel: 'OPENAI_API_KEY' },
      { id: 'google', nome: 'Gemini', variavel: 'GEMINI_API_KEY' },
      { id: 'opencode', nome: 'OpenCode', variavel: 'OPENROUTER_API_KEY' },
    ]);
  });

  it('lê variáveis e argumentos do cadastro de agente ACP', () => {
    expect(parseEnvPairs('A=1; B = dois\nC=')).toEqual({ A: '1', B: 'dois', C: '' });
    expect(parseEnvPairs('')).toEqual({});
    expect(parseEnvPairs('sem igual')).toBe('"sem igual" is not NAME=value');
    expect(parseArgs('acp --modo "com espaço" \'x y\'')).toEqual([
      'acp',
      '--modo',
      'com espaço',
      'x y',
    ]);
  });

  it('descreve o estado e só sugere os comandos que faltam', () => {
    const ready = status({
      instalado: true,
      pronto: true,
      modo: 'chave',
      versao: '0.98.0',
      perfis: ['codex', 'codex-luna'],
    });
    expect(statusLine(ready).description).toBe(
      'ready via API key · v0.98.0 · profiles: codex, codex-luna',
    );
    expect(statusLine(status({ modelos: ['gpt-5'] }))).toMatchObject({
      description: 'not ready',
      detail: 'models: gpt-5',
    });
    expect(fixCommands(ready)).toEqual([]);
    expect(
      fixCommands(status({ instalar: 'npm install -g @agentclientprotocol/codex-acp' })),
    ).toEqual(['npm install -g @agentclientprotocol/codex-acp']);
    expect(fixCommands(status({ instalado: true, login: 'codex login' }))).toEqual(['codex login']);
    // Servidor local: a instrução é para ler, não para rodar no terminal.
    expect(
      fixCommands(status({ id: 'ollama', tipo: 'local', instalar: 'baixe o Ollama' })),
    ).toEqual([]);
  });

  it('avisa do adaptador desatualizado e só marca o que ficou para trás', () => {
    const update = (instalada: string, ultima: string, desatualizada: boolean) => ({
      pacote: '@agentclientprotocol/codex-acp',
      comando: 'codex-acp',
      instalada,
      ultima,
      desatualizada,
      atualizar: 'npm install -g @agentclientprotocol/codex-acp@latest',
    });
    const old = status({
      instalado: true,
      pronto: true,
      modo: 'assinatura',
      atualizacoes: [update('1.0.0', '2.2.2', true), update('2.2.2', '2.2.2', false)],
    });
    expect(outdated(old)).toHaveLength(1);
    expect(statusLine(old)).toMatchObject({
      description: 'ready via subscription · update available',
      detail: 'codex-acp 1.0.0 → 2.2.2',
    });
    expect(outdated(status({ atualizacoes: [update('2.2.2', '2.2.2', false)] }))).toEqual([]);
    expect(statusLine(status({ instalado: true })).description).toBe('not ready');
  });

  it('descreve o estado em pt-BR', () => {
    useLocale('pt-br');
    expect(
      statusLine(
        status({
          instalado: true,
          pronto: true,
          modo: 'chave',
          versao: '0.98.0',
          perfis: ['codex'],
        }),
      ).description,
    ).toBe('pronto por chave de API · v0.98.0 · perfis: codex');
    expect(statusLine(status({})).description).toBe('não está pronto');
    expect(parseEnvPairs('sem igual')).toBe('"sem igual" não é NOME=valor');
  });
});
