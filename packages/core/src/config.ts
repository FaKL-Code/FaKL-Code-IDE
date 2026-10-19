import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentProfile } from '@fakl/agents';
import {
  DELIVERIES,
  AGENT_ADAPTERS,
  type AgentAdapterName,
  type LovableProject,
  type DailyCap,
  type Delivery,
  type PostMergeBuild,
  type RunLimits,
  type AgentProfileDefinition,
  type AgentProfileEntry,
  type McpServerConfig,
  type TerminalProfileOptions,
  PERMISSION_MODES,
  type PermissionPolicyName,
  isVozModo,
  VOZ_MODOS,
  VOZ_MODOS_NO_CORE,
  type VozModoNoCore,
} from '@fakl/protocol';
import { currentLocale, l10n } from '@fakl/i18n';
import { parse, parseDocument, stringify, type Document } from 'yaml';

import type { EventBus } from './events/bus.js';
import { parseLimits } from './orchestrator/limits.js';
import { isModoEconomia, MODOS_ECONOMIA, type ModoEconomia } from './economia/compactar.js';
import { faklHome } from './paths.js';
import { objectParams, RpcError, stringParam, type Router } from './rpc/router.js';

/** `~/.fakl/config.yaml` (SDD 6.5): o que vale para todos os agentes. */
export interface FaklConfig {
  /** Servidores MCP entregues a todo agente (RF-006). */
  readonly mcpServers: readonly McpServerConfig[];
  /** Política de permissão quando quem inicia o agente não escolhe. */
  readonly permissoes: PermissionPolicyName;
  /** Teto diário de gasto por provedor (RNF-13). */
  readonly tetoDiario: Readonly<Record<string, DailyCap>>;
  /** Limites globais das execuções (RF-206); tarefa e playbook podem mudar. */
  readonly limites?: RunLimits;
  /** Como entregar o resultado aprovado (RF-209); padrão, PR + merge. */
  readonly entrega?: Delivery;
  /** Workflow disparado depois do merge da entrega `pr-merge`; sem ele, nenhum. */
  readonly buildAposMerge?: PostMergeBuild;
  /** Vault de notas (SDD 10); sem ele, as ferramentas do vault ficam desligadas. */
  readonly vault?: VaultConfig;
  /** Controle remoto (SDD 12). */
  readonly remoto?: RemoteConfig;
  /** Repositórios ligados a projetos Lovable (SDD 11.4). */
  readonly lovable?: readonly LovableProject[];
  /** Comandos por voz (`voz.*`): desligada até a pessoa escolher um modo. */
  readonly voz?: VozConfig;
  /**
   * Mostra na Mesa e no café as conversas das extensões do Codex e do Claude Code,
   * lendo o histórico local delas (ADR 0039). Desligado até o usuário consentir.
   */
  readonly sessoesExternas?: boolean;
  /** Modo econômico de tokens (ADR 0052); sem a chave, `equilibrado`. */
  readonly economia?: ModoEconomia;
}

/** `voz` no config.yaml: o modo escolhido (ver `VOZ_MODOS` no protocolo). */
export type VozConfig = VozBrowserConfig | VozServerConfig;

/** `voz.modo: navegador`: o celular reconhece a fala; o Core não transcreve. */
export interface VozBrowserConfig {
  readonly modo: 'navegador';
  /** Idioma da fala; padrão `pt`. */
  readonly idioma: string;
}

/** Modos do Core: servidor de transcrição compatível com a API da OpenAI. */
export interface VozServerConfig {
  readonly modo: VozProvider;
  /** Padrão por provedor (ver {@link VOZ_DEFAULTS}). */
  readonly modelo: string;
  /** Padrão: o endereço do provedor. */
  readonly endpoint: string;
  /** Idioma da fala quando o pedido não diz; padrão `pt`. */
  readonly idioma: string;
  /** Maior áudio aceito, em MB; padrão 20. */
  readonly limiteMb: number;
}

export const VOZ_PROVIDERS = VOZ_MODOS_NO_CORE;
export type VozProvider = VozModoNoCore;

export const VOZ_DEFAULTS: Readonly<Record<VozProvider, { modelo: string; endpoint: string }>> = {
  openai: { modelo: 'gpt-4o-mini-transcribe', endpoint: 'https://api.openai.com/v1' },
  groq: { modelo: 'whisper-large-v3-turbo', endpoint: 'https://api.groq.com/openai/v1' },
  local: { modelo: 'whisper-1', endpoint: 'http://127.0.0.1:8000/v1' },
};
const VOZ_DEFAULT_LIMIT_MB = 20;

/** `remoto` no config.yaml. */
export interface RemoteConfig {
  /** Endereço HTTPS do relay no seu VPS. */
  readonly relay?: string;
  /** Chave do relay (FAKL_RELAY_KEY), se ele exigir uma. */
  readonly chave?: string;
  /** Liga o acesso remoto ao abrir a IDE (SDD 12.5); padrão, desligado. */
  readonly ligarAoAbrir?: boolean;
  /** Nome desta máquina no celular; padrão, o hostname. */
  readonly nome?: string;
}

/** `vault` no config.yaml. */
export interface VaultConfig {
  /** Pasta do vault; `~` é a pasta pessoal. */
  readonly caminho: string;
  /** Repositório git privado; clonado na primeira abertura se a pasta não existe. */
  readonly remoto?: string;
  /** Sincroniza sozinho (SDD 10.2); padrão, sim quando há remoto ou origin. */
  readonly sincronizar?: boolean;
  /** Busca semântica (RF-407): desligada sem esta chave. */
  readonly semantica?: SemanticConfig;
}

/** `vault.semantica`: modelo de embeddings num servidor local compatível com OpenAI. */
export interface SemanticConfig {
  readonly provedor: SemanticProvider;
  /** Ex.: nomic-embed-text no Ollama. */
  readonly modelo: string;
  /** Padrão: o endereço local do provedor. */
  readonly endpoint?: string;
}

export const SEMANTIC_PROVIDERS = ['ollama', 'lmstudio'] as const;
export type SemanticProvider = (typeof SEMANTIC_PROVIDERS)[number];

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const DEFAULT_CONFIG: FaklConfig = { mcpServers: [], permissoes: 'perguntar', tetoDiario: {} };
const POLICIES: readonly PermissionPolicyName[] = PERMISSION_MODES;
const COSTS = ['baixo', 'médio', 'alto'] as const;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RELOAD_DELAY_MS = 150;

/** O que a primeira abertura achou, para os exemplos do config.yaml citarem o que existe. */
export interface FirstRunInfo {
  /** Provedores prontos na máquina. */
  readonly provedores: readonly string[];
  /** Perfis criados para eles. */
  readonly perfis: readonly AgentProfile[];
}

/**
 * Cabeçalho comentado do config.yaml. Os exemplos de escalada e teto diário
 * citam os perfis e provedores desta máquina; sem nenhum, ficam genéricos.
 */
export function configHeader(info: FirstRunInfo = { provedores: [], perfis: [] }): string {
  const strongest =
    info.perfis.find((profile) => profile.custoRelativo === 'alto') ??
    info.perfis.find((profile) => profile.podeSerMaestro);
  const escalada = strongest?.id ?? l10n.t('<id of a stronger profile>');
  const [first, second] = info.provedores;
  const provider = l10n.t('<provider>');
  const caps = [
    `#   ${first ?? provider}: { custoUsd: 20 }`,
    `#   ${second ?? first ?? provider}: { tokens: 2000000 }`,
  ];
  if (second === undefined && first !== undefined) caps.pop();
  // Só os comentários mudam de idioma: chaves e valores são os que o Core lê.
  return `# ${l10n.t('FaKL-Code configuration (SDD 6.5). Applies to all agents.')}
#
# mcpServers:          ${l10n.t('MCP servers given to every agent')}
#   - nome: arquivos
#     comando: npx
#     args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
# permissoes: perguntar   # perguntar | aprovar-leitura | aprovar-tudo | autopilot
# limites:             ${l10n.t('limits of each maestro run (the task can change them)')}
#   rodadas: { valor: 5, acao: perguntar }   # perguntar | rascunho | escalar | descartar
#   tempoMin: { valor: 120 }
#   custoUsd: { valor: 10, acao: rascunho }
#   perfilEscalada: ${escalada}
# entrega: pr-merge    # pr-merge (${l10n.t('PR and merge on GitHub')}) | merge | pr | branch
# buildAposMerge:      ${l10n.t('workflow triggered after the pr-merge merge, if the repo has it')}
#   workflow: build.yml
#   inputs: { plataformas: windows }   # ${l10n.t('only the inputs the workflow declares are sent')}
# vault:              ${l10n.t('Markdown notes, compatible with Obsidian')}
#   caminho: ~/Vault
#   remoto: git@github.com:voce/vault-privado.git   # ${l10n.t('optional; syncs across machines')}
# remoto:             ${l10n.t('remote control from the phone (SDD 12)')}
#   relay: https://relay.exemplo.com
#   chave: ...           # ${l10n.t('the relay FAKL_RELAY_KEY, if it requires one')}
#   ligarAoAbrir: false
# lovable:            ${l10n.t('repositories synced with Lovable projects (SDD 11.4)')}
#   - repo: voce/meu-site
#     url: https://lovable.dev/projects/...
#     branch: main
# voz:                ${l10n.t('voice commands; off until you choose a mode ("FaKL: Configure voice")')}
#   modo: navegador    # navegador (${l10n.t('phone Web Speech API, no key')}) | openai | groq
#                      # | local (speaches, faster-whisper-server, whisper.cpp)
#   modelo: whisper-large-v3-turbo   # ${l10n.t('openai, groq and local only; default per provider')}
#   endpoint: http://127.0.0.1:8000/v1   # ${l10n.t('openai, groq and local only; optional')}
#   idioma: pt
#   limiteMb: 20       # ${l10n.t('the API key goes in the keychain (voz.token), never here')}
# economia:           ${l10n.t('token saving mode: desligado, equilibrado (default) or agressivo')}
# sessoesExternas: false  ${l10n.t('true shows, read-only, the conversations of the Codex and Claude Code extensions by reading their local history')}
# tetoDiario:          ${l10n.t('maximum spending per provider per day; when reached, agents pause')}
${caps.join('\n')}
`;
}

/** Lista de alternativas no idioma da interface ("a ou b", "a or b"). */
function oneOf(items: readonly string[]): string {
  return new Intl.ListFormat(currentLocale(), { type: 'disjunction' }).format(items);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  raw: Record<string, unknown>,
  name: string,
  where: string,
): string | undefined {
  const value = raw[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw new ConfigError(l10n.t('{0}: {1} must be text', where, name));
  return value;
}

function optionalStrings(
  raw: Record<string, unknown>,
  name: string,
  where: string,
): string[] | undefined {
  const value = raw[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ConfigError(l10n.t('{0}: {1} must be a list of texts', where, name));
  }
  return value;
}

/** Valida um perfil lido de YAML ou recebido pela API. */
export function parseProfile(raw: unknown, where: string): AgentProfileDefinition {
  if (!isObject(raw)) throw new ConfigError(l10n.t('{0}: the profile must be an object', where));
  const id = optionalString(raw, 'id', where);
  if (!id || !PROFILE_ID.test(id)) {
    throw new ConfigError(
      l10n.t('{0}: id must have only lowercase letters, numbers and hyphens', where),
    );
  }
  const nome = optionalString(raw, 'nome', where);
  if (!nome) throw new ConfigError(l10n.t('{0}: nome is missing', where));
  const provedor = optionalString(raw, 'provedor', where);
  if (!provedor) throw new ConfigError(l10n.t('{0}: provedor is missing', where));
  const adaptador = raw.adaptador ?? 'acp';
  if (!AGENT_ADAPTERS.includes(adaptador as AgentAdapterName)) {
    throw new ConfigError(
      l10n.t('{0}: {1} must be {2}', where, 'adaptador', oneOf(AGENT_ADAPTERS)),
    );
  }
  const custo = raw.custoRelativo;
  if (custo !== undefined && !COSTS.includes(custo as (typeof COSTS)[number])) {
    throw new ConfigError(l10n.t('{0}: {1} must be {2}', where, 'custoRelativo', COSTS.join(', ')));
  }
  if (raw.podeSerMaestro !== undefined && typeof raw.podeSerMaestro !== 'boolean') {
    throw new ConfigError(l10n.t('{0}: {1} must be true or false', where, 'podeSerMaestro'));
  }
  const permissoes = raw.permissoes;
  if (permissoes !== undefined && !POLICIES.includes(permissoes as PermissionPolicyName)) {
    throw new ConfigError(l10n.t('{0}: {1} must be {2}', where, 'permissoes', POLICIES.join(', ')));
  }

  const comando = optionalString(raw, 'comando', where);
  const args = optionalStrings(raw, 'args', where);
  const modelo = optionalString(raw, 'modelo', where);
  const endpoint = optionalString(raw, 'endpoint', where);
  if (endpoint && !/^https?:\/\//.test(endpoint)) {
    throw new ConfigError(l10n.t('{0}: endpoint must start with http:// or https://', where));
  }
  const env = raw.env;
  if (
    env !== undefined &&
    env !== null &&
    (!isObject(env) || !Object.values(env).every((value) => typeof value === 'string'))
  ) {
    throw new ConfigError(l10n.t('{0}: env must map names to texts', where));
  }
  const chaveEnv = optionalString(raw, 'chaveEnv', where);
  if (chaveEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(chaveEnv)) {
    throw new ConfigError(
      l10n.t('{0}: chaveEnv must be the name of an environment variable', where),
    );
  }
  if (adaptador === 'terminal' && !comando) {
    throw new ConfigError(l10n.t('{0}: the terminal adapter needs a comando', where));
  }
  const terminal = parseTerminalOptions(raw.terminal, where);
  const pontosFortes = optionalStrings(raw, 'pontosFortes', where);
  const regras = optionalStrings(raw, 'regras', where);
  const ferramentas = optionalStrings(raw, 'ferramentasPermitidas', where);
  return {
    id,
    nome,
    provedor,
    adaptador: adaptador as AgentAdapterName,
    ...(endpoint ? { endpoint } : {}),
    ...(comando ? { comando } : {}),
    ...(args ? { args } : {}),
    ...(isObject(env) && Object.keys(env).length > 0 ? { env: env as Record<string, string> } : {}),
    ...(chaveEnv ? { chaveEnv } : {}),
    ...(modelo ? { modelo } : {}),
    ...(pontosFortes ? { pontosFortes } : {}),
    ...(custo ? { custoRelativo: custo as (typeof COSTS)[number] } : {}),
    ...(regras ? { regras } : {}),
    ...(typeof raw.podeSerMaestro === 'boolean' ? { podeSerMaestro: raw.podeSerMaestro } : {}),
    ...(ferramentas ? { ferramentasPermitidas: ferramentas } : {}),
    ...(permissoes ? { permissoes: permissoes as PermissionPolicyName } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

/** `terminal:` de um perfil de agente de terminal: regex do prompt e segundos de silêncio. */
function parseTerminalOptions(raw: unknown, where: string): TerminalProfileOptions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw))
    throw new ConfigError(l10n.t('{0}: {1} must be an object', where, 'terminal'));
  const prompt = optionalString(raw, 'prompt', where);
  if (prompt !== undefined) {
    try {
      new RegExp(prompt);
    } catch {
      throw new ConfigError(
        l10n.t('{0}: terminal.prompt is not a valid regular expression', where),
      );
    }
  }
  const silencio = raw.silencioSegundos;
  if (
    silencio !== undefined &&
    (typeof silencio !== 'number' || !Number.isFinite(silencio) || silencio < 0.5 || silencio > 600)
  ) {
    throw new ConfigError(
      l10n.t('{0}: terminal.silencioSegundos must be a number from 0.5 to 600', where),
    );
  }
  return {
    ...(prompt ? { prompt } : {}),
    ...(typeof silencio === 'number' ? { silencioSegundos: silencio } : {}),
  };
}

/** Valida `config.yaml`; campos ausentes ficam com o padrão. */
export function parseConfig(raw: unknown, where: string): FaklConfig {
  if (raw === undefined || raw === null) return DEFAULT_CONFIG;
  if (!isObject(raw))
    throw new ConfigError(l10n.t('{0}: the configuration must be an object', where));
  const servers = raw.mcpServers ?? [];
  if (!Array.isArray(servers)) {
    throw new ConfigError(l10n.t('{0}: {1} must be a list', where, 'mcpServers'));
  }
  const mcpServers = servers.map((server, index): McpServerConfig => {
    const at = `${where}: mcpServers[${String(index)}]`;
    if (!isObject(server)) throw new ConfigError(l10n.t('{0} must be an object', at));
    const nome = optionalString(server, 'nome', at);
    const comando = optionalString(server, 'comando', at);
    if (!nome || !comando) throw new ConfigError(l10n.t('{0} needs nome and comando', at));
    const args = optionalStrings(server, 'args', at);
    const env = server.env;
    if (
      env !== undefined &&
      (!isObject(env) || !Object.values(env).every((value) => typeof value === 'string'))
    ) {
      throw new ConfigError(l10n.t('{0}: env must map names to texts', at));
    }
    return {
      nome,
      comando,
      ...(args ? { args } : {}),
      ...(env ? { env: env as Record<string, string> } : {}),
    };
  });
  const permissoes = raw.permissoes ?? DEFAULT_CONFIG.permissoes;
  if (!POLICIES.includes(permissoes as PermissionPolicyName)) {
    throw new ConfigError(l10n.t('{0}: {1} must be {2}', where, 'permissoes', POLICIES.join(', ')));
  }
  return {
    mcpServers,
    permissoes: permissoes as PermissionPolicyName,
    tetoDiario: parseCaps(raw.tetoDiario, where),
    ...parseRunDefaults(raw, where),
    ...parsePostMergeBuild(raw.buildAposMerge, where),
    ...parseVault(raw.vault, where),
    ...parseRemote(raw.remoto, where),
    ...parseLovable(raw.lovable, where),
    ...parseVoz(raw.voz, where),
    ...(raw.sessoesExternas === true ? { sessoesExternas: true } : {}),
    ...parseEconomia(raw.economia, where),
  };
}

/** O texto, ou o padrão quando ausente ou vazio. */
function nonEmpty(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

function parseVoz(raw: unknown, where: string): { voz?: VozConfig } {
  if (raw === undefined || raw === null || raw === false) return {};
  const at = `${where}: voz`;
  if (!isObject(raw)) throw new ConfigError(l10n.t('{0} must be an object with modo', at));
  // `provedor` é o nome antigo de `modo` (antes do navegador).
  const modo = raw.modo ?? raw.provedor;
  if (!isVozModo(modo)) {
    throw new ConfigError(l10n.t('{0}: {1} must be {2}', at, 'modo', VOZ_MODOS.join(', ')));
  }
  if (modo === 'navegador') {
    return { voz: { modo, idioma: nonEmpty(optionalString(raw, 'idioma', at), 'pt') } };
  }
  const defaults = VOZ_DEFAULTS[modo];
  const modelo = nonEmpty(optionalString(raw, 'modelo', at), defaults.modelo);
  const endpoint = nonEmpty(optionalString(raw, 'endpoint', at), defaults.endpoint).replace(
    /\/+$/,
    '',
  );
  if (!/^https?:\/\//.test(endpoint)) {
    throw new ConfigError(l10n.t('{0}: endpoint must start with http:// or https://', at));
  }
  const idioma = nonEmpty(optionalString(raw, 'idioma', at), 'pt');
  const limite = raw.limiteMb ?? VOZ_DEFAULT_LIMIT_MB;
  if (typeof limite !== 'number' || !Number.isFinite(limite) || limite <= 0 || limite > 200) {
    throw new ConfigError(l10n.t('{0}: limiteMb must be a number between 0 and 200', at));
  }
  return {
    voz: { modo, modelo, endpoint, idioma, limiteMb: limite },
  };
}

function parseLovable(raw: unknown, where: string): { lovable?: LovableProject[] } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw))
    throw new ConfigError(l10n.t('{0}: {1} must be a list', where, 'lovable'));
  return {
    lovable: raw.map((item: unknown, i): LovableProject => {
      const at = `${where}: lovable[${String(i)}]`;
      if (!isObject(item)) throw new ConfigError(l10n.t('{0} must be an object', at));
      const repo = optionalString(item, 'repo', at);
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        throw new ConfigError(l10n.t('{0}: repo must be owner/name', at));
      }
      const url = optionalString(item, 'url', at);
      if (!url?.startsWith('https://')) {
        throw new ConfigError(l10n.t('{0}: url must start with https://', at));
      }
      const branch = optionalString(item, 'branch', at);
      return { repo, url, ...(branch ? { branch } : {}) };
    }),
  };
}

/** O texto sem espaços nas pontas; vazio vira `undefined`. */
function filled(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

/** O que há de errado com o endereço do relay; `undefined` quando serve. */
export function relayUrlProblem(relay: string): string | undefined {
  let url: URL;
  try {
    url = new URL(relay);
  } catch {
    return l10n.t('relay must be an address like https://relay.example.com');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return l10n.t('relay needs https (the phone requires a secure connection)');
  }
  return undefined;
}

function parseRemote(raw: unknown, where: string): { remoto?: RemoteConfig } {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new ConfigError(l10n.t('{0}: {1} must be an object', where, 'remoto'));
  const at = `${where}: remoto`;
  const relay = optionalString(raw, 'relay', at);
  if (relay !== undefined) {
    const problem = relayUrlProblem(relay);
    if (problem) throw new ConfigError(`${at}: ${problem}`);
  }
  const chave = optionalString(raw, 'chave', at);
  const nome = optionalString(raw, 'nome', at);
  const ligar = raw.ligarAoAbrir;
  if (ligar !== undefined && typeof ligar !== 'boolean') {
    throw new ConfigError(l10n.t('{0}: {1} must be true or false', at, 'ligarAoAbrir'));
  }
  return {
    remoto: {
      ...(relay ? { relay } : {}),
      ...(chave ? { chave } : {}),
      ...(nome ? { nome } : {}),
      ...(ligar !== undefined ? { ligarAoAbrir: ligar } : {}),
    },
  };
}

function parseVault(raw: unknown, where: string): { vault?: VaultConfig } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') return raw ? { vault: { caminho: raw } } : {};
  if (!isObject(raw)) throw new ConfigError(l10n.t('{0}: {1} must be an object', where, 'vault'));
  const at = `${where}: vault`;
  const caminho = optionalString(raw, 'caminho', at);
  if (!caminho) throw new ConfigError(l10n.t('{0} needs caminho', at));
  const remoto = optionalString(raw, 'remoto', at);
  const sincronizar = raw.sincronizar;
  if (sincronizar !== undefined && typeof sincronizar !== 'boolean') {
    throw new ConfigError(l10n.t('{0}: {1} must be true or false', at, 'sincronizar'));
  }
  const semantica = parseSemantic(raw.semantica, `${at}: semantica`);
  return {
    vault: {
      caminho,
      ...(remoto ? { remoto } : {}),
      ...(sincronizar !== undefined ? { sincronizar } : {}),
      ...(semantica ? { semantica } : {}),
    },
  };
}

function parseSemantic(raw: unknown, at: string): SemanticConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  if (!isObject(raw)) {
    throw new ConfigError(l10n.t('{0} must be an object with provedor and modelo', at));
  }
  const provedor = raw.provedor ?? 'ollama';
  if (!(SEMANTIC_PROVIDERS as readonly unknown[]).includes(provedor)) {
    throw new ConfigError(
      l10n.t('{0}: {1} must be {2}', at, 'provedor', oneOf(SEMANTIC_PROVIDERS)),
    );
  }
  const modelo = optionalString(raw, 'modelo', at);
  if (!modelo) throw new ConfigError(l10n.t('{0} needs modelo (e.g. nomic-embed-text)', at));
  const endpoint = optionalString(raw, 'endpoint', at);
  if (endpoint && !/^https?:\/\//.test(endpoint)) {
    throw new ConfigError(l10n.t('{0}: endpoint must start with http:// or https://', at));
  }
  return { provedor: provedor as SemanticProvider, modelo, ...(endpoint ? { endpoint } : {}) };
}

function parseRunDefaults(
  raw: Record<string, unknown>,
  where: string,
): { limites?: RunLimits; entrega?: Delivery } {
  let limites: RunLimits | undefined;
  try {
    limites = parseLimits(raw.limites, `${where}: limites`);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  const entrega = raw.entrega;
  if (entrega !== undefined && !DELIVERIES.includes(entrega as Delivery)) {
    throw new ConfigError(l10n.t('{0}: {1} must be {2}', where, 'entrega', DELIVERIES.join(', ')));
  }
  return {
    ...(limites ? { limites } : {}),
    ...(entrega ? { entrega: entrega as Delivery } : {}),
  };
}

function parseEconomia(raw: unknown, where: string): { economia?: ModoEconomia } {
  if (raw === undefined || raw === null) return {};
  if (!isModoEconomia(raw)) {
    throw new ConfigError(
      l10n.t('{0}: {1} must be {2}', where, 'economia', MODOS_ECONOMIA.join(', ')),
    );
  }
  return { economia: raw };
}

function parsePostMergeBuild(raw: unknown, where: string): { buildAposMerge?: PostMergeBuild } {
  if (raw === undefined || raw === null || raw === false) return {};
  const at = `${where}: buildAposMerge`;
  if (!isObject(raw)) throw new ConfigError(l10n.t('{0} must be an object with workflow', at));
  const workflow = optionalString(raw, 'workflow', at);
  if (!workflow || !/^[\w.-]+\.ya?ml$/.test(workflow)) {
    throw new ConfigError(l10n.t('{0}: workflow must be the file name, for example build.yml', at));
  }
  const inputs = raw.inputs;
  if (inputs !== undefined && inputs !== null && !isObject(inputs)) {
    throw new ConfigError(l10n.t('{0}: inputs must map names to values', at));
  }
  const entries = Object.entries(inputs ?? {});
  if (!entries.every(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))) {
    throw new ConfigError(l10n.t('{0}: inputs values must be texts, numbers or booleans', at));
  }
  return {
    buildAposMerge: {
      workflow,
      ...(entries.length
        ? { inputs: Object.fromEntries(entries.map(([key, value]) => [key, String(value)])) }
        : {}),
    },
  };
}

function parseCaps(raw: unknown, where: string): Record<string, DailyCap> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    throw new ConfigError(l10n.t('{0}: tetoDiario must map providers to caps', where));
  }
  const caps: Record<string, DailyCap> = {};
  for (const [provedor, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      throw new ConfigError(l10n.t('{0}: {1} must be an object', where, `tetoDiario.${provedor}`));
    }
    const cap: { custoUsd?: number; tokens?: number } = {};
    for (const key of ['custoUsd', 'tokens'] as const) {
      const n = value[key];
      if (n === undefined || n === null) continue;
      if (typeof n !== 'number' || !(n >= 0)) {
        throw new ConfigError(
          l10n.t('{0}: {1} must be a number', where, `tetoDiario.${provedor}.${key}`),
        );
      }
      cap[key] = n;
    }
    caps[provedor] = cap;
  }
  return caps;
}

export interface ConfigStoreOptions {
  /** Pasta pessoal; a configuração fica em `<home>/.fakl`. */
  readonly home: string;
  readonly bus?: EventBus;
  readonly log?: (message: string) => void;
  /**
   * Primeira abertura: cria os perfis dos provedores prontos (ADR 0035) e diz
   * o que achou, para o config.yaml comentado citar o que existe.
   */
  readonly firstRun?: () => Promise<FirstRunInfo>;
}

/**
 * Perfis (`~/.fakl/profiles/<id>.yaml`, SDD 7) e configuração geral
 * (`~/.fakl/config.yaml`). Os arquivos são a fonte da verdade: o usuário edita
 * à mão ou pela IDE, o cofre os sincroniza entre máquinas, e o Core relê ao
 * mudar, publicando `config.changed`.
 */
export class ConfigStore {
  private entries: AgentProfileEntry[] = [];
  private current: FaklConfig = DEFAULT_CONFIG;
  private readonly watchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private problems: string[] = [];

  constructor(private readonly options: ConfigStoreOptions) {}

  get dir(): string {
    return faklHome(this.options.home);
  }

  get profilesDir(): string {
    return join(this.dir, 'profiles');
  }

  get configFile(): string {
    return join(this.dir, 'config.yaml');
  }

  get profiles(): readonly AgentProfile[] {
    return this.entries.map((entry) => entry.profile);
  }

  get config(): FaklConfig {
    return this.current;
  }

  /** Arquivos que não puderam ser lidos na última leitura. */
  get errors(): readonly string[] {
    return this.problems;
  }

  profileEntries(): readonly AgentProfileEntry[] {
    return this.entries;
  }

  /**
   * Lê tudo. Na primeira abertura cria a pasta de perfis, só com os perfis dos
   * provedores prontos na máquina, e um config.yaml comentado.
   */
  async load(): Promise<void> {
    await this.seed();
    const problems: string[] = [];
    const entries: AgentProfileEntry[] = [];
    const names = (await readdir(this.profilesDir).catch(() => []))
      .filter((name) => /\.ya?ml$/i.test(name))
      .sort();
    const seen = new Set<string>();
    for (const name of names) {
      const arquivo = join(this.profilesDir, name);
      try {
        const profile = parseProfile(parse(await readFile(arquivo, 'utf8')), name);
        if (seen.has(profile.id)) {
          throw new ConfigError(l10n.t('{0}: id {1} repeated', name, profile.id));
        }
        seen.add(profile.id);
        entries.push({ profile, arquivo });
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    let config = DEFAULT_CONFIG;
    try {
      const text = await readFile(this.configFile, 'utf8').catch(() => undefined);
      if (text !== undefined) config = parseConfig(parse(text), 'config.yaml');
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      // Mantém a configuração anterior em vez de cair para o padrão no meio de uma edição.
      config = this.current;
    }
    this.entries = entries;
    this.current = config;
    this.problems = problems;
    for (const problem of problems) this.options.log?.(l10n.t('configuration: {0}', problem));
  }

  private async seed(): Promise<void> {
    const created = await mkdir(this.profilesDir, { recursive: true });
    if (created === undefined) return;
    let info: FirstRunInfo | undefined;
    try {
      info = await this.options.firstRun?.();
    } catch (error) {
      this.options.log?.(l10n.t('could not detect the AI providers: {0}', String(error)));
    }
    await writeFile(this.configFile, configHeader(info), { flag: 'wx' }).catch(() => undefined);
  }

  /** Grava um perfil novo sem reler; `false` se já existe um arquivo com o id. */
  async createProfile(profile: AgentProfile): Promise<boolean> {
    parseProfile(profile, l10n.t('profile'));
    if (this.entries.some((entry) => entry.profile.id === profile.id)) return false;
    await mkdir(this.profilesDir, { recursive: true });
    try {
      await writeFile(this.fileFor(profile.id), stringify(profile), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }

  private fileFor(id: string): string {
    return join(this.profilesDir, `${id}.yaml`);
  }

  /** Relê quando um arquivo muda e avisa pelo barramento. */
  watch(): void {
    const schedule = (): void => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_DELAY_MS);
    };
    for (const dir of [this.dir, this.profilesDir]) {
      try {
        const watcher = watch(dir, (_event, name) => {
          if (dir === this.dir && name !== 'config.yaml') return;
          schedule();
        });
        watcher.on('error', () => undefined);
        this.watchers.push(watcher);
      } catch (error) {
        this.options.log?.(l10n.t('could not watch {0}: {1}', dir, String(error)));
      }
    }
  }

  async reload(): Promise<void> {
    await this.load();
    this.options.bus?.publish('config.changed', 'config', {
      profiles: this.entries.map((entry) => entry.profile.id),
      errors: this.problems,
    });
  }

  profile(id: string): AgentProfile | undefined {
    return this.entries.find((entry) => entry.profile.id === id)?.profile;
  }

  async upsert(raw: unknown): Promise<AgentProfileEntry> {
    const profile = parseProfile(raw, l10n.t('profile'));
    const arquivo =
      this.entries.find((entry) => entry.profile.id === profile.id)?.arquivo ??
      this.fileFor(profile.id);
    await mkdir(this.profilesDir, { recursive: true });
    await writeFile(arquivo, stringify(profile));
    await this.reload();
    return { profile, arquivo };
  }

  async remove(id: string): Promise<boolean> {
    const entry = this.entries.find((candidate) => candidate.profile.id === id);
    if (!entry) return false;
    await rm(entry.arquivo, { force: true });
    await this.reload();
    return true;
  }

  /** Grava a política de permissão padrão (`permissoes:`) no config.yaml. */
  async setPermissions(mode: PermissionPolicyName): Promise<void> {
    if (!POLICIES.includes(mode)) {
      throw new ConfigError(l10n.t('{0} must be {1}', 'permissoes', POLICIES.join(', ')));
    }
    await this.setKey('permissoes', mode === DEFAULT_CONFIG.permissoes ? undefined : mode);
  }

  /** Grava os tetos no config.yaml mantendo os comentários e o resto do arquivo. */
  async setDailyCaps(caps: Readonly<Record<string, DailyCap>>): Promise<void> {
    await this.setKey('tetoDiario', Object.keys(caps).length === 0 ? undefined : caps);
  }

  /** Grava `vault:` no config.yaml; sem valor, desliga o vault. */
  async setVault(vault: VaultConfig | undefined): Promise<void> {
    if (vault) parseVault(vault, 'vault');
    await this.setKey('vault', vault);
  }

  /** Grava `remoto:` no config.yaml, mantendo o que não mudou. */
  async setRemote(change: RemoteConfig): Promise<void> {
    const merged = { ...this.config.remoto, ...change };
    parseRemote(merged, 'remoto');
    await this.setKey('remoto', merged);
  }

  /**
   * Grava `voz:` no config.yaml; `modo: null` desliga a voz. Ao trocar de
   * provedor, modelo e endpoint voltam ao padrão do novo, salvo se vierem.
   */
  async setVoz(change: {
    readonly modo: VozConfig['modo'] | null;
    readonly modelo?: string;
    readonly endpoint?: string;
    readonly idioma?: string;
  }): Promise<VozConfig | undefined> {
    if (change.modo === null) {
      await this.setKey('voz', undefined);
      return undefined;
    }
    const current = this.config.voz;
    const same =
      current?.modo === change.modo && current.modo !== 'navegador' ? current : undefined;
    const raw: Record<string, unknown> = { modo: change.modo };
    if (change.modo !== 'navegador') {
      const defaults = VOZ_DEFAULTS[change.modo];
      const modelo = filled(change.modelo) ?? same?.modelo;
      const endpoint = (filled(change.endpoint) ?? same?.endpoint)?.replace(/\/+$/, '');
      if (modelo && modelo !== defaults.modelo) raw.modelo = modelo;
      if (endpoint && endpoint !== defaults.endpoint) raw.endpoint = endpoint;
    }
    const idioma = filled(change.idioma) ?? current?.idioma;
    if (idioma && idioma !== 'pt') raw.idioma = idioma;
    if (current && current.modo !== 'navegador' && current.limiteMb !== VOZ_DEFAULT_LIMIT_MB) {
      if (change.modo !== 'navegador') raw.limiteMb = current.limiteMb;
    }
    const parsed = parseVoz(raw, 'voz').voz;
    await this.setKey('voz', raw);
    return parsed;
  }

  /** Grava `economia:` no config.yaml; `equilibrado`, o padrão, apaga a chave. */
  async setEconomia(modo: ModoEconomia): Promise<void> {
    await this.setKey('economia', modo === 'equilibrado' ? undefined : modo);
  }

  /** Grava `sessoesExternas:` no config.yaml; desligar apaga a chave. */
  async setExternalSessions(enabled: boolean): Promise<void> {
    await this.setKey('sessoesExternas', enabled ? true : undefined);
  }

  /** Grava a lista `lovable:` no config.yaml; lista vazia apaga a chave. */
  async setLovable(projects: readonly LovableProject[]): Promise<void> {
    parseLovable(projects, 'lovable');
    await this.setKey('lovable', projects.length > 0 ? projects : undefined);
  }

  /** Muda uma chave do config.yaml mantendo comentários e o resto do arquivo. */
  private async setKey(key: string, value: unknown): Promise<void> {
    const text = await readFile(this.configFile, 'utf8').catch(() => '');
    const doc = parseDocument(text);
    if (doc.errors.length > 0) {
      throw new ConfigError(`config.yaml: ${doc.errors[0]?.message ?? l10n.t('invalid')}`);
    }
    if (doc.contents === null) (doc as Document).contents = doc.createNode({});
    if (value === undefined) doc.delete(key);
    else doc.set(key, doc.createNode(value));
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.configFile, doc.toString());
    await this.reload();
  }

  register(router: Router): void {
    router.register('config.permissions.get', () => ({ permissoes: this.config.permissoes }));
    router.register('config.permissions.set', async (params) => {
      const mode = stringParam(objectParams(params), 'permissoes');
      try {
        await this.setPermissions(mode as PermissionPolicyName);
      } catch (error) {
        if (error instanceof ConfigError) throw RpcError.invalidParams(error.message);
        throw error;
      }
      return { permissoes: this.config.permissoes };
    });
    router.register('profiles.list', () => this.entries);
    router.register('profiles.get', (params) => {
      const id = stringParam(objectParams(params), 'id');
      const entry = this.entries.find((candidate) => candidate.profile.id === id);
      if (!entry) throw RpcError.notFound(l10n.t('profile {0} does not exist', id));
      return entry;
    });
    router.register('profiles.upsert', async (params) => {
      try {
        return await this.upsert(objectParams(params).profile);
      } catch (error) {
        if (error instanceof ConfigError) throw RpcError.invalidParams(error.message);
        throw error;
      }
    });
    router.register('profiles.delete', async (params) => {
      const id = stringParam(objectParams(params), 'id');
      if (!(await this.remove(id))) {
        throw RpcError.notFound(l10n.t('profile {0} does not exist', id));
      }
      return null;
    });
  }

  dispose(): void {
    clearTimeout(this.reloadTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
  }
}
