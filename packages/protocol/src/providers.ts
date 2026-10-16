/**
 * Provedores de IA (ADR 0035): quem a IDE consegue usar agora. Ninguém precisa
 * ter as três assinaturas: vale assinatura pelo CLI, chave de API, modelo local
 * ou qualquer agente compatível com ACP. Sem nenhum, a IDE funciona sem IA.
 */

/** Provedores com CLI oficial e preset de perfis. */
export const CLI_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];

/** Servidores de modelo local, pela API compatível com OpenAI. */
export const LOCAL_PROVIDERS = ['ollama', 'lmstudio'] as const;
export type LocalProvider = (typeof LOCAL_PROVIDERS)[number];

export function isCliProvider(value: string): value is CliProvider {
  return (CLI_PROVIDERS as readonly string[]).includes(value);
}

export function isLocalProvider(value: string): value is LocalProvider {
  return (LOCAL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Como os agentes de um provedor se autenticam:
 * - `assinatura`: login feito no CLI (Claude Pro/Max, ChatGPT, conta Google);
 * - `chave`: chave de API guardada no cofre da IDE;
 * - `local`: servidor de modelo na própria máquina;
 * - `acp`: agente ACP cadastrado pelo usuário, que cuida do próprio login.
 */
export const PROVIDER_MODES = ['assinatura', 'chave', 'local', 'acp'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

/** Variável de ambiente da chave de API de cada provedor com CLI. */
export const PROVIDER_KEY_ENV: Readonly<Record<CliProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
};

/** Nome que a interface mostra para cada provedor conhecido. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Claude',
  openai: 'Codex',
  google: 'Gemini',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

export function providerName(provedor: string): string {
  return PROVIDER_NAMES[provedor] ?? provedor;
}

/** Id de provedor de um agente ACP cadastrado: o mesmo formato dos ids de perfil. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isProviderId(value: string): boolean {
  return PROVIDER_ID.test(value);
}

/** Segredo da chave de API de um provedor no cofre (`secrets.set`). */
export function apiKeySecretName(provedor: string): `apikey.${string}` {
  return `apikey.${provedor}`;
}

/** Família visual do provedor: a cor do agente na Mesa, no overlay e no celular. */
export type ProviderFamily = 'claude' | 'codex' | 'gemini' | 'local' | 'outro';

export function providerFamily(provedor: string | undefined): ProviderFamily {
  switch (provedor) {
    case 'anthropic':
      return 'claude';
    case 'openai':
      return 'codex';
    case 'google':
      return 'gemini';
    case 'ollama':
    case 'lmstudio':
      return 'local';
    default:
      return 'outro';
  }
}

/** Um provedor como `providers.detect` o encontrou. */
export interface ProviderStatus {
  /** `anthropic`, `openai`, `google`, `ollama`, `lmstudio` ou o id de um agente ACP cadastrado. */
  readonly id: string;
  readonly nome: string;
  readonly tipo: 'cli' | 'local' | 'acp';
  /** O executável do agente foi achado no PATH (ou o servidor local respondeu). */
  readonly instalado: boolean;
  /** Executável do agente ou endereço do servidor local. */
  readonly caminho?: string;
  /** Saída de `--version` do CLI, quando ele responde. */
  readonly versao?: string;
  /** Login feito no CLI; ausente quando não dá para saber (agentes ACP cadastrados). */
  readonly logado?: boolean;
  /** Há chave de API deste provedor no cofre da IDE. */
  readonly chave: boolean;
  /** Variável que recebe a chave de API, quando o provedor aceita chave. */
  readonly chaveEnv?: string;
  /** Como os agentes vão se autenticar; ausente enquanto o provedor não está pronto. */
  readonly modo?: ProviderMode;
  /** Instalado e com login, chave, servidor local ativo ou agente ACP achado. */
  readonly pronto: boolean;
  /** Comando que instala o que falta. */
  readonly instalar?: string;
  /** Comando (ou passo) que faz o login. */
  readonly login?: string;
  /** Modelos do servidor local. */
  readonly modelos?: readonly string[];
  /** Perfis que já usam este provedor. */
  readonly perfis: readonly string[];
  /** O que falta, numa frase, quando não está pronto; ou um aviso útil. */
  readonly aviso?: string;
}

/** `providers.detect`. */
export interface ProvidersDetectResult {
  readonly provedores: readonly ProviderStatus[];
}

/** `providers.generateProfiles`: perfis gravados para os provedores prontos sem perfil. */
export interface ProvidersGenerateResult {
  readonly criados: readonly string[];
  readonly provedores: readonly ProviderStatus[];
}

/**
 * `providers.acp.add`: cadastra um agente compatível com ACP (OpenCode, Qwen
 * Code, ...) como provedor, com um perfil que roda `comando args`.
 */
export interface ProviderAcpAddParams {
  /** Id do provedor e do perfil, como `opencode`. */
  readonly id: string;
  readonly nome: string;
  readonly comando: string;
  readonly args?: readonly string[];
  /** Variáveis extras do agente, sem segredos (a chave vai pelo cofre, em `chaveEnv`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Variável que recebe a chave de API guardada no cofre para este provedor. */
  readonly chaveEnv?: string;
  readonly modelo?: string;
}
