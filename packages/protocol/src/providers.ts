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

/** Um pacote npm do provedor (adaptador ACP ou CLI) comparado com a última versão publicada. */
export interface ProviderUpdate {
  /** Pacote no npm, como `@agentclientprotocol/codex-acp`. */
  readonly pacote: string;
  /** Comando do pacote no PATH, como `codex-acp`. */
  readonly comando: string;
  /** O pacote é o adaptador ACP ou o CLI oficial (iguais no Gemini, que traz o ACP no próprio CLI). */
  readonly papel?: 'adaptador' | 'cli';
  readonly instalada: string;
  readonly ultima: string;
  /** A última publicada é mais nova que a instalada. */
  readonly desatualizada: boolean;
  /** Comando que atualiza o pacote; quem roda é o usuário, depois de confirmar. */
  readonly atualizar: string;
}

/** `providers.detect`: com `atualizacoes`, consulta o npm pela última versão de cada pacote. */
export interface ProvidersDetectParams {
  readonly atualizacoes?: boolean;
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
  /** O CLI oficial (o do login) foi achado no PATH; nos provedores sem CLI à parte vale o mesmo que `instalado`. */
  readonly cliInstalado?: boolean;
  /** Como o login do Gemini está configurado (`oauth-personal`, `gemini-api-key`, `vertex-ai`...); só no Google. */
  readonly loginTipo?: string;
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
  /** Versões instaladas contra a última do npm; só com `atualizacoes` e quando o npm respondeu. */
  readonly atualizacoes?: readonly ProviderUpdate[];
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

/** `providers.environment`: o que o diagnóstico precisa saber da máquina além do que `providers.detect` diz. */
export interface ProvidersEnvironment {
  /** Versão do Node que o Core enxerga no PATH; ausente quando não há. */
  readonly node?: string;
  readonly npm?: string;
  /** Provedores com a variável da chave de API no ambiente, mas sem chave no cofre da IDE. */
  readonly chavesNoAmbiente: readonly string[];
  /** Teste do servidor MCP `fakl` que o Core injeta nos agentes; ausente quando o Core não o oferece. */
  readonly mcp?: McpProbe;
}

/** Resultado de lançar o servidor MCP `fakl` com um token fictício e pedir `initialize` e `tools/list`. */
export interface McpProbe {
  readonly ok: boolean;
  /** Ferramentas que ele listou, quando respondeu. */
  readonly ferramentas?: number;
  readonly motivo?: 'nao-encontrado' | 'saiu' | 'sem-resposta';
  /** Código de saída, quando o processo terminou. */
  readonly codigo?: number;
  /** Últimas linhas do stderr. */
  readonly stderr?: string;
}
