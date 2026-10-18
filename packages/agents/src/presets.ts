import { l10n } from '@fakl/i18n';
import {
  PROVIDER_KEY_ENV,
  isCliProvider,
  type CliProvider,
  type LocalProvider,
} from '@fakl/protocol';

import { AcpAdapter, type AcpCommand } from './acp.js';
import { LocalAdapter } from './local.js';
import type { AgentAdapter, AgentProfile } from './types.js';

/**
 * Agente ACP padrão de cada provedor (SDD 8.2). O Gemini CLI fala ACP
 * direto; Claude Code e Codex entram pelos adaptadores ACP oficiais. Com chave
 * de API no cofre, `keyAuth` diz qual método de login do ACP usa a chave.
 */
export const providerCommands = (): Readonly<Record<CliProvider, AcpCommand>> => ({
  anthropic: {
    command: 'claude-agent-acp',
    args: [],
    install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    login: l10n.t('run `claude auth login` in a terminal, or store an API key'),
    // O Claude Code usa ANTHROPIC_API_KEY sozinho, sem um passo de login no ACP.
    keyAuth: { env: PROVIDER_KEY_ENV.anthropic, methods: [] },
  },
  openai: {
    command: 'codex-acp',
    args: [],
    install: 'npm install -g @agentclientprotocol/codex-acp',
    login: l10n.t('run `codex login` in a terminal, or store an API key'),
    keyAuth: { env: PROVIDER_KEY_ENV.openai, methods: ['openai-api-key', 'codex-api-key'] },
  },
  google: {
    command: 'gemini',
    args: ['--acp'],
    install: 'npm install -g @google/gemini-cli',
    login: l10n.t(
      'store an API key from Google AI Studio (a personal Google account no longer works)',
    ),
    keyAuth: { env: PROVIDER_KEY_ENV.google, methods: ['gemini-api-key'] },
  },
});

/** CLI oficial de cada provedor: onde se faz o login e de onde vem a versão. */
export interface ProviderCli {
  readonly command: string;
  readonly install: string;
  /** Comando que faz o login da assinatura. */
  readonly login: string;
}

export const PROVIDER_CLIS: Readonly<Record<CliProvider, ProviderCli>> = {
  anthropic: {
    command: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  },
  openai: { command: 'codex', install: 'npm install -g @openai/codex', login: 'codex login' },
  google: { command: 'gemini', install: 'npm install -g @google/gemini-cli', login: 'gemini' },
};

/** Pacotes npm de cada provedor: o adaptador ACP que a IDE sobe e o CLI oficial. */
export const PROVIDER_PACKAGES: Readonly<
  Record<CliProvider, { readonly adapter: string; readonly cli: string }>
> = {
  anthropic: {
    adapter: '@agentclientprotocol/claude-agent-acp',
    cli: '@anthropic-ai/claude-code',
  },
  openai: { adapter: '@agentclientprotocol/codex-acp', cli: '@openai/codex' },
  google: { adapter: '@google/gemini-cli', cli: '@google/gemini-cli' },
};

/** Agente compatível com ACP de terceiros que a IDE já sabe cadastrar. */
export interface AcpAgentPreset {
  readonly id: string;
  readonly nome: string;
  readonly comando: string;
  readonly args: readonly string[];
  readonly install: string;
}

/** Os conhecidos; o usuário pode cadastrar qualquer outro informando comando e argumentos. */
export const ACP_AGENT_PRESETS: readonly AcpAgentPreset[] = [
  {
    id: 'opencode',
    nome: 'OpenCode',
    comando: 'opencode',
    args: ['acp'],
    install: 'npm install -g opencode-ai',
  },
  {
    id: 'qwen',
    nome: 'Qwen Code',
    comando: 'qwen',
    args: ['--acp'],
    install: 'npm install -g @qwen-code/qwen-code',
  },
];

/**
 * Perfis de fábrica de cada provedor com CLI. A IDE grava só os dos provedores
 * prontos na máquina (ADR 0035); pontos fortes e custo vêm do levantamento de
 * modelos de 2026-10, e o maestro os lê em list_profiles.
 */
export const providerProfiles = (): Readonly<Record<CliProvider, readonly AgentProfile[]>> => ({
  anthropic: [
    {
      id: 'claude',
      nome: 'Claude Code',
      provedor: 'anthropic',
      adaptador: 'acp',
      pontosFortes: [
        l10n.t('general implementation'),
        l10n.t('code review'),
        l10n.t('terminal and CI'),
        l10n.t('orchestration'),
      ],
      custoRelativo: 'médio',
    },
    {
      id: 'claude-haiku',
      nome: 'Claude Haiku',
      provedor: 'anthropic',
      adaptador: 'acp',
      modelo: 'claude-haiku-5-5',
      pontosFortes: [
        l10n.t('mechanical tasks'),
        l10n.t('triage, searches and summaries'),
        l10n.t('short documentation'),
        l10n.t('lint, formatting and dependencies'),
        l10n.t('simple tests'),
      ],
      custoRelativo: 'baixo',
    },
    {
      id: 'claude-sonnet',
      nome: 'Claude Sonnet',
      provedor: 'anthropic',
      adaptador: 'acp',
      modelo: 'claude-sonnet-5-5',
      pontosFortes: [
        l10n.t('day-to-day implementation'),
        l10n.t('test writing'),
        l10n.t('terminal, CI and DevOps'),
        l10n.t('frontend and code review'),
        l10n.t('data and SQL'),
      ],
      custoRelativo: 'médio',
      podeSerMaestro: true,
    },
    {
      id: 'claude-opus',
      nome: 'Claude Opus',
      provedor: 'anthropic',
      adaptador: 'acp',
      modelo: 'claude-opus-5-5',
      pontosFortes: [
        l10n.t('architecture, migrations and large refactors'),
        l10n.t('hard debugging'),
        l10n.t('UI with visual taste'),
        l10n.t('pt-BR writing'),
        l10n.t('long autonomous runs and orchestration'),
      ],
      custoRelativo: 'alto',
      podeSerMaestro: true,
    },
  ],
  openai: [
    {
      id: 'codex',
      nome: 'Codex',
      provedor: 'openai',
      adaptador: 'acp',
      pontosFortes: [
        l10n.t('backend implementation'),
        l10n.t('test-driven fixes'),
        l10n.t('mechanical refactors'),
        l10n.t('security review'),
        l10n.t('orchestration'),
      ],
      custoRelativo: 'médio',
      podeSerMaestro: true,
    },
    {
      id: 'codex-luna',
      nome: 'Codex Luna',
      provedor: 'openai',
      adaptador: 'acp',
      modelo: 'gpt-6-luna',
      pontosFortes: [
        l10n.t('light edits in volume'),
        l10n.t('short subtasks'),
        l10n.t('fallback when the quota runs out'),
      ],
      custoRelativo: 'baixo',
    },
  ],
  google: [
    {
      id: 'gemini',
      nome: 'Gemini CLI',
      provedor: 'google',
      adaptador: 'acp',
      pontosFortes: [
        l10n.t('fast, cheap exploratory reading'),
        l10n.t('triage and summaries of large codebases'),
        l10n.t('images, charts and video'),
        l10n.t('short terminal commands'),
      ],
      custoRelativo: 'baixo',
      podeSerMaestro: true,
    },
  ],
});

/**
 * Todos os perfis de fábrica juntos. Só valem quando o Core roda sem pasta de
 * configuração (testes); numa instalação, os perfis vêm dos provedores prontos.
 */
export const defaultProfiles = (): readonly AgentProfile[] =>
  Object.values(providerProfiles()).flat();

/** Modelos locais preferidos para programar, na ordem: o primeiro instalado vira o perfil. */
const LOCAL_MODEL_PREFERENCE = [/coder/i, /qwen/i, /deepseek/i, /llama/i, /mistral|codestral/i];

/** Modelos que não conversam (embeddings, reranking) não viram perfil de agente. */
const NON_CHAT_MODEL = /embed|rerank|bge-|nomic|clip|whisper/i;

/** O modelo local mais indicado para um agente, entre os que o servidor tem. */
export function pickLocalModel(models: readonly string[]): string | undefined {
  const chat = models.filter((model) => !NON_CHAT_MODEL.test(model));
  for (const pattern of LOCAL_MODEL_PREFERENCE) {
    const found = chat.find((model) => pattern.test(model));
    if (found) return found;
  }
  return chat[0];
}

/** Perfil de um servidor local (Ollama ou LM Studio) com o modelo escolhido. */
export function localProfile(provedor: LocalProvider, modelo: string): AgentProfile {
  return {
    id: provedor,
    nome: `${provedor === 'ollama' ? 'Ollama' : 'LM Studio'} (${modelo})`,
    provedor,
    adaptador: 'ollama',
    modelo,
    pontosFortes: [
      l10n.t('small, well-defined tasks'),
      l10n.t('data that cannot leave the machine'),
      l10n.t('use without quota or cost'),
    ],
    custoRelativo: 'baixo',
  };
}

/**
 * Adaptador de um perfil. Um perfil `ollama` fala com o modelo local (RF-104);
 * um com `comando` roda qualquer agente ACP (RF-103); sem ele, vale o agente
 * padrão do provedor.
 */
export function adapterForProfile(
  profile: AgentProfile,
  hostEnv: NodeJS.ProcessEnv = process.env,
): AgentAdapter {
  if (profile.adaptador === 'ollama') return new LocalAdapter(profile, { hostEnv });
  return new AcpAdapter(commandForProfile(profile), hostEnv);
}

/** Comando de um perfil, com o modelo pedido do jeito que cada CLI entende. */
export function commandForProfile(profile: AgentProfile): AcpCommand {
  const model = modelOptions(profile);
  const env = { ...profile.env, ...model.env };
  const withEnv = Object.keys(env).length > 0 ? { env } : {};
  if (profile.comando) {
    const known = ACP_AGENT_PRESETS.find((preset) => preset.comando === profile.comando);
    return {
      command: profile.comando,
      args: [...(profile.args ?? []), ...model.args],
      ...withEnv,
      ...(known ? { install: known.install } : {}),
      // A chave que o usuário guardou para este agente chega na variável que ele pediu.
      ...(profile.chaveEnv ? { keyAuth: { env: profile.chaveEnv, methods: [] } } : {}),
    };
  }
  if (!isCliProvider(profile.provedor)) {
    throw new Error(
      l10n.t(
        'profile {0}: provider {1} has no default agent; provide the command',
        profile.id,
        profile.provedor,
      ),
    );
  }
  const preset = providerCommands()[profile.provedor];
  return {
    ...preset,
    args: [...(profile.args ?? preset.args), ...model.args],
    ...withEnv,
  };
}

function modelOptions(profile: AgentProfile): {
  args: string[];
  env?: Record<string, string>;
} {
  const model = profile.modelo?.trim();
  if (!model) return { args: [] };
  switch (profile.provedor) {
    case 'anthropic':
      // O claude-agent-acp repassa o ambiente ao Claude Code, que lê o modelo daqui.
      return { args: [], env: { ANTHROPIC_MODEL: model } };
    case 'openai':
      return { args: ['-c', `model=${JSON.stringify(model)}`] };
    case 'google':
      return { args: ['--model', model] };
    default:
      return { args: [] };
  }
}
