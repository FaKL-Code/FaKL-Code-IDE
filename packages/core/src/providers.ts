import { rmSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ACP_AGENT_PRESETS,
  findExecutable,
  LOCAL_ENDPOINTS,
  localProfile,
  pickLocalModel,
  PROVIDER_CLIS,
  PROVIDER_PACKAGES,
  providerCommands,
  providerProfiles,
  type AgentProfile,
} from '@fakl/agents';
import { l10n } from '@fakl/i18n';
import {
  apiKeySecretName,
  CLI_PROVIDERS,
  isCliProvider,
  isLocalProvider,
  isProviderId,
  LOCAL_PROVIDERS,
  PROVIDER_KEY_ENV,
  providerName,
  type CliProvider,
  type LocalProvider,
  type ProviderAcpAddParams,
  type ProviderMode,
  type ProvidersDetectResult,
  type ProvidersEnvironment,
  type ProvidersGenerateResult,
  type ProviderStatus,
  type ProviderUpdate,
} from '@fakl/protocol';

import { parseAuthStatus } from './claude-accounts.js';
import { run, runShell } from './exec.js';
import { probeMcp, type McpProbeLauncher } from './mcp/probe.js';
import { objectParams, RpcError, type Router } from './rpc/router.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Resultado de rodar um CLI: só o código e a saída padrão. */
export interface CliResult {
  readonly code: number;
  readonly stdout: string;
}

export type CliRunner = (file: string, args: readonly string[], env: Env) => Promise<CliResult>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProviderServiceOptions {
  /** Perfis em vigor agora. */
  readonly profiles: () => readonly AgentProfile[];
  /** Grava um perfil novo; `false` se já existe um arquivo com o id (nunca sobrescreve). */
  readonly createProfile: (profile: AgentProfile) => Promise<boolean>;
  /** Relê os perfis depois de criar alguns. */
  readonly reload?: () => Promise<void>;
  /** Há chave de API no cofre para o provedor? */
  readonly hasKey: (provedor: string) => boolean;
  /** Ambiente do Core: PATH e as pastas dos CLIs (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`). */
  readonly env: Env;
  readonly home: string;
  /**
   * Onde fica a lista de provedores que já ganharam perfis sozinhos; um
   * provedor cujos perfis o usuário apagou não volta na próxima abertura.
   */
  readonly stateFile?: string;
  /** Alguma conta do Claude da IDE (ADR 0021) tem login? */
  readonly claudeAccountsLoggedIn?: () => Promise<boolean>;
  readonly runCli?: CliRunner;
  readonly fetch?: FetchLike;
  /** Última versão publicada de um pacote no npm; `undefined` quando não deu para saber. */
  readonly latestVersion?: (pacote: string) => Promise<string | undefined>;
  /** Como o Core lança o servidor MCP `fakl`; sem isto o diagnóstico não o testa. */
  readonly mcp?: McpProbeLauncher;
  /** Teste do servidor MCP; muda nos testes. */
  readonly probeMcp?: typeof probeMcp;
  readonly platform?: NodeJS.Platform;
  readonly log?: (message: string) => void;
}

export interface DetectOptions {
  /** Roda `--version` nos CLIs encontrados; a geração de perfis pula isso. */
  readonly versions?: boolean;
  /** Compara as versões instaladas com a última do npm (precisa de `versions`). */
  readonly updates?: boolean;
}

const VERSION_TIMEOUT_MS = 5_000;
const REGISTRY_TIMEOUT_MS = 3_000;
const REGISTRY_CACHE_MS = 60 * 60_000;
const LOCAL_TIMEOUT_MS = 1_500;
/** Login por credencial da nuvem do Google, sem arquivo de OAuth. */
const GEMINI_CLOUD_AUTH = new Set(['vertex-ai', 'compute-default-credentials', 'cloud-shell']);

/** Como instalar um servidor local; função porque o idioma é escolhido depois de carregar o módulo. */
function localInstall(id: LocalProvider): string {
  switch (id) {
    case 'ollama':
      return l10n.t(
        'download Ollama from https://ollama.com/download and run `ollama pull qwen2.5-coder`',
      );
    case 'lmstudio':
      return l10n.t(
        'download LM Studio from https://lmstudio.ai, download a model and start the local server',
      );
  }
}

const defaultRunner: CliRunner = async (file, args, env) => {
  const options = { cwd: process.cwd(), env, timeoutMs: VERSION_TIMEOUT_MS, tailChars: 4_000 };
  // Os CLIs do npm no Windows são `.cmd`, que um spawn sem shell não roda.
  const result = /\.(cmd|bat)$/i.test(file)
    ? await runShell(`"${file}" ${args.join(' ')}`, options)
    : await run(file, args, options);
  return { code: result.code, stdout: result.stdout };
};

function envValue(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  const value = key ? env[key] : undefined;
  // Variável vazia conta como ausente.
  return value === '' ? undefined : value;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** `a` é mais nova que `b`, comparando major.minor.patch; pré-lançamento vale como a versão final. */
export function isNewer(a: string, b: string): boolean {
  const parts = (version: string): number[] =>
    (version.split(/[-+]/)[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const registryCache = new Map<string, { at: number; version: string }>();

/**
 * Última versão de um pacote no registro do npm. Uma consulta curta, sem
 * identificador do usuário (só o nome do pacote vai na URL), com tempo limite
 * e guardada por uma hora; sem rede ou com resposta estranha, `undefined`.
 */
export async function npmLatestVersion(
  pacote: string,
  fetcher: FetchLike = (input, init) => fetch(input, init),
): Promise<string | undefined> {
  const cached = registryCache.get(pacote);
  if (cached && Date.now() - cached.at < REGISTRY_CACHE_MS) return cached.version;
  try {
    const response = await fetcher(`https://registry.npmjs.org/${pacote}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const version = field(await response.json(), 'version');
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) return undefined;
    registryCache.set(pacote, { at: Date.now(), version });
    return version;
  } catch {
    return undefined;
  }
}

/** "2.1.3" de "2.1.3 (Claude Code)" ou "codex-cli 0.98.0". */
export function parseVersion(stdout: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/.exec(stdout)?.[0];
}

/**
 * Quem a IDE consegue usar (ADR 0035): CLIs instalados e logados, chaves de
 * API, servidores locais e agentes ACP cadastrados. A jornada de configuração
 * chama `providers.detect`; os perfis nascem só para os provedores prontos.
 */
export class ProviderService {
  private generated: Set<string> | undefined;

  constructor(private readonly options: ProviderServiceOptions) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private which(command: string): Promise<string | undefined> {
    return findExecutable(command, this.options.env, this.platform);
  }

  private async runCli(file: string, args: readonly string[]): Promise<CliResult> {
    try {
      return await (this.options.runCli ?? defaultRunner)(file, args, this.options.env);
    } catch {
      return { code: -1, stdout: '' };
    }
  }

  private async version(file: string | undefined): Promise<string | undefined> {
    if (!file) return undefined;
    const result = await this.runCli(file, ['--version']);
    return result.code === 0 ? parseVersion(result.stdout) : undefined;
  }

  private profilesOf(provedor: string): string[] {
    return this.options
      .profiles()
      .filter((profile) => profile.provedor === provedor)
      .map((profile) => profile.id);
  }

  async detect(options: DetectOptions = {}): Promise<ProviderStatus[]> {
    const acp = this.acpProviders();
    return Promise.all([
      ...CLI_PROVIDERS.map((id) => this.detectCli(id, options)),
      ...LOCAL_PROVIDERS.map((id) => this.detectLocal(id)),
      ...[...acp.entries()].map(([id, profile]) => this.detectAcp(id, profile)),
    ]);
  }

  /** Agentes ACP cadastrados: perfis com comando próprio de um provedor que não é dos conhecidos. */
  private acpProviders(): Map<string, AgentProfile> {
    const found = new Map<string, AgentProfile>();
    for (const profile of this.options.profiles()) {
      const { provedor } = profile;
      if (isCliProvider(provedor) || isLocalProvider(provedor)) continue;
      if (!profile.comando || found.has(provedor)) continue;
      found.set(provedor, profile);
    }
    return found;
  }

  private async detectCli(id: CliProvider, options: DetectOptions): Promise<ProviderStatus> {
    const command = providerCommands()[id];
    const cli = PROVIDER_CLIS[id];
    const [agentPath, cliPath] = await Promise.all([
      this.which(command.command),
      cli.command === command.command ? undefined : this.which(cli.command),
    ]);
    const loginPath = cli.command === command.command ? agentPath : cliPath;
    const chave = this.options.hasKey(id);
    const chaveEnv = PROVIDER_KEY_ENV[id];
    const [logado, versao, atualizacoes] = await Promise.all([
      this.loggedIn(id, loginPath),
      options.versions ? this.version(loginPath ?? agentPath) : Promise.resolve(undefined),
      options.versions && options.updates
        ? this.updatesOf(id, agentPath, cliPath)
        : Promise.resolve([]),
    ]);
    const instalado = agentPath !== undefined;
    const loginTipo = id === 'google' ? await this.geminiLoginType() : undefined;
    const modo: ProviderMode | undefined = !instalado
      ? undefined
      : chave
        ? 'chave'
        : logado
          ? 'assinatura'
          : undefined;
    const missing = [
      ...(instalado ? [] : [command.install]),
      // O CLI oficial só faz falta para o login da assinatura.
      ...(loginPath || chave || logado ? [] : [cli.install]),
    ].filter((item): item is string => !!item);
    const shellKey = !chave && envValue(this.options.env, chaveEnv) !== undefined;
    const aviso = !instalado
      ? l10n.t('install the agent: {0}', missing.join(' && '))
      : !modo
        ? shellKey
          ? l10n.t(
              '{0} is set in the environment, but agents only receive keys stored in the IDE: use "FaKL: Set API key"',
              chaveEnv,
            )
          : l10n.t('sign in (`{0}`) or store an API key', cli.login)
        : undefined;
    return {
      id,
      nome: providerName(id),
      tipo: 'cli',
      instalado,
      ...(agentPath ? { caminho: agentPath } : {}),
      ...(versao ? { versao } : {}),
      cliInstalado: loginPath !== undefined,
      ...(loginTipo ? { loginTipo } : {}),
      logado,
      chave,
      chaveEnv,
      ...(modo ? { modo } : {}),
      pronto: modo !== undefined,
      ...(missing.length > 0 ? { instalar: missing.join(' && ') } : {}),
      login: cli.login,
      perfis: this.profilesOf(id),
      ...(atualizacoes.length > 0 ? { atualizacoes } : {}),
      ...(aviso ? { aviso } : {}),
    };
  }

  /**
   * Adaptador ACP e CLI do provedor contra a última versão do npm. O adaptador
   * é quem traz o Codex ou o Claude Code embutido, então um adaptador velho
   * pode esconder modelos novos mesmo com o login em dia.
   */
  private async updatesOf(
    id: CliProvider,
    agentPath: string | undefined,
    cliPath: string | undefined,
  ): Promise<ProviderUpdate[]> {
    const packages = PROVIDER_PACKAGES[id];
    const targets = [
      { pacote: packages.adapter, comando: providerCommands()[id].command, path: agentPath },
      ...(packages.cli === packages.adapter
        ? []
        : [{ pacote: packages.cli, comando: PROVIDER_CLIS[id].command, path: cliPath }]),
    ];
    const latest =
      this.options.latestVersion ??
      ((pacote: string) => npmLatestVersion(pacote, this.options.fetch));
    const found = await Promise.all(
      targets.map(async ({ pacote, comando, path }): Promise<ProviderUpdate | undefined> => {
        if (!path) return undefined;
        const [instalada, ultima] = await Promise.all([
          this.version(path),
          latest(pacote).catch(() => undefined),
        ]);
        if (!instalada || !ultima) return undefined;
        return {
          pacote,
          comando,
          papel: pacote === packages.adapter ? 'adaptador' : 'cli',
          instalada,
          ultima,
          desatualizada: isNewer(ultima, instalada),
          atualizar: `npm install -g ${pacote}@latest`,
        };
      }),
    );
    return found.filter((item): item is ProviderUpdate => item !== undefined);
  }

  /**
   * Login da assinatura, pelo que o CLI grava; nada é lido além de saber se
   * existe. No macOS o Claude guarda o token no Keychain: aí vale
   * `claude auth status`.
   */
  private async loggedIn(id: CliProvider, cliPath: string | undefined): Promise<boolean> {
    const { env, home } = this.options;
    switch (id) {
      case 'anthropic': {
        const dir = envValue(env, 'CLAUDE_CONFIG_DIR') ?? join(home, '.claude');
        if (await isFile(join(dir, '.credentials.json'))) return true;
        const state = await readJson(
          envValue(env, 'CLAUDE_CONFIG_DIR')
            ? join(dir, '.claude.json')
            : join(home, '.claude.json'),
        );
        if (field(state, 'oauthAccount') !== undefined) return true;
        if (await this.options.claudeAccountsLoggedIn?.().catch(() => false)) return true;
        if (!cliPath) return false;
        const status = await this.runCli(cliPath, ['auth', 'status']);
        return parseAuthStatus(status.stdout).logada === true;
      }
      case 'openai': {
        const auth = await readJson(
          join(envValue(env, 'CODEX_HOME') ?? join(home, '.codex'), 'auth.json'),
        );
        return (
          field(auth, 'tokens', 'access_token') !== undefined ||
          typeof field(auth, 'OPENAI_API_KEY') === 'string'
        );
      }
      case 'google': {
        const dir = join(envValue(env, 'GEMINI_CLI_HOME') ?? home, '.gemini');
        if (await isFile(join(dir, 'oauth_creds.json'))) return true;
        const settings = await readJson(join(dir, 'settings.json'));
        const selected =
          field(settings, 'security', 'auth', 'selectedType') ??
          field(settings, 'selectedAuthType');
        return typeof selected === 'string' && GEMINI_CLOUD_AUTH.has(selected);
      }
    }
  }

  /**
   * Como o login do Gemini está configurado, só pelo tipo escolhido em
   * `settings.json`; o conteúdo de `oauth_creds.json` nunca é lido. Com o
   * arquivo de OAuth e nenhuma escolha, vale o padrão do CLI: conta pessoal.
   */
  private async geminiLoginType(): Promise<string | undefined> {
    const { env, home } = this.options;
    const dir = join(envValue(env, 'GEMINI_CLI_HOME') ?? home, '.gemini');
    const settings = await readJson(join(dir, 'settings.json'));
    const selected =
      field(settings, 'security', 'auth', 'selectedType') ?? field(settings, 'selectedAuthType');
    if (typeof selected === 'string') return selected;
    return (await isFile(join(dir, 'oauth_creds.json'))) ? 'oauth-personal' : undefined;
  }

  /** Node, npm e chaves só no ambiente: o que o diagnóstico (FaKL: Doctor) precisa além do `detect`. */
  async environment(): Promise<ProvidersEnvironment> {
    const tool = async (command: string): Promise<string | undefined> =>
      this.version(await this.which(command));
    const launcher = this.options.mcp;
    const [node, npm, mcp] = await Promise.all([
      tool('node'),
      tool('npm'),
      launcher
        ? (this.options.probeMcp ?? probeMcp)(launcher, { env: this.options.env })
        : undefined,
    ]);
    const chavesNoAmbiente = CLI_PROVIDERS.filter(
      (id) =>
        !this.options.hasKey(id) && envValue(this.options.env, PROVIDER_KEY_ENV[id]) !== undefined,
    );
    return {
      ...(node ? { node } : {}),
      ...(npm ? { npm } : {}),
      chavesNoAmbiente,
      ...(mcp ? { mcp } : {}),
    };
  }

  private async detectLocal(id: LocalProvider): Promise<ProviderStatus> {
    const configured = this.options
      .profiles()
      .find((profile) => profile.provedor === id && profile.endpoint)?.endpoint;
    const endpoint = (configured ?? LOCAL_ENDPOINTS[id] ?? '').replace(/\/+$/, '');
    let modelos: string[] | undefined;
    try {
      const fetcher = this.options.fetch ?? ((input, init) => fetch(input, init));
      const response = await fetcher(`${endpoint}/models`, {
        signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: { id?: unknown }[] };
        modelos = (body.data ?? [])
          .map((model) => (typeof model.id === 'string' ? model.id : ''))
          .filter(Boolean);
      }
    } catch {
      // Servidor fechado ou não instalado.
    }
    const instalado = modelos !== undefined;
    const usable = pickLocalModel(modelos ?? []);
    const pronto = usable !== undefined;
    return {
      id,
      nome: providerName(id),
      tipo: 'local',
      instalado,
      caminho: endpoint,
      chave: false,
      ...(pronto ? { modo: 'local' as const } : {}),
      pronto,
      ...(instalado ? {} : { instalar: localInstall(id) }),
      ...(modelos ? { modelos } : {}),
      perfis: this.profilesOf(id),
      ...(pronto
        ? {}
        : {
            aviso: instalado
              ? l10n.t('the local server has no chat model; download a model')
              : l10n.t('no server at {0}', endpoint),
          }),
    };
  }

  private async detectAcp(id: string, profile: AgentProfile): Promise<ProviderStatus> {
    const comando = profile.comando ?? id;
    const found = await this.which(comando);
    const preset = ACP_AGENT_PRESETS.find((candidate) => candidate.comando === comando);
    return {
      id,
      nome: profile.nome,
      tipo: 'acp',
      instalado: found !== undefined,
      ...(found ? { caminho: found } : {}),
      chave: this.options.hasKey(id),
      ...(profile.chaveEnv ? { chaveEnv: profile.chaveEnv } : {}),
      ...(found ? { modo: 'acp' as const } : {}),
      pronto: found !== undefined,
      ...(!found && preset ? { instalar: preset.install } : {}),
      perfis: this.profilesOf(id),
      ...(found ? {} : { aviso: l10n.t('{0} is not on the IDE PATH', comando) }),
    };
  }

  private async loadGenerated(): Promise<Set<string>> {
    if (this.generated) return this.generated;
    const file = this.options.stateFile;
    const raw = file ? await readJson(file) : undefined;
    const list = field(raw, 'gerados');
    this.generated = new Set(
      Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [],
    );
    return this.generated;
  }

  private async saveGenerated(): Promise<void> {
    const file = this.options.stateFile;
    if (!file || !this.generated) return;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ gerados: [...this.generated].sort() }, null, 2)}\n`);
  }

  /**
   * Grava os perfis dos provedores prontos que ainda não têm nenhum. Sem
   * `provedores`, um provedor que já ganhou perfis antes fica de fora (o
   * usuário pode tê-los apagado); com a lista, ela manda. Perfil existente
   * nunca é sobrescrito.
   */
  async generateProfiles(provedores?: readonly string[]): Promise<ProvidersGenerateResult> {
    const statuses = await this.detect();
    const generated = await this.loadGenerated();
    const criados: string[] = [];
    for (const status of statuses) {
      if (!status.pronto || status.perfis.length > 0) continue;
      if (provedores ? !provedores.includes(status.id) : generated.has(status.id)) continue;
      const profiles = this.presetsFor(status);
      if (profiles.length === 0) continue;
      for (const profile of profiles) {
        if (await this.options.createProfile(profile)) criados.push(profile.id);
      }
      generated.add(status.id);
    }
    if (criados.length > 0) {
      await this.saveGenerated();
      await this.options.reload?.();
      this.options.log?.(
        l10n.t('profiles created for the ready providers: {0}', criados.join(', ')),
      );
    }
    return {
      criados,
      provedores: statuses.map((status) => ({ ...status, perfis: this.profilesOf(status.id) })),
    };
  }

  private presetsFor(status: ProviderStatus): readonly AgentProfile[] {
    if (isCliProvider(status.id)) return providerProfiles()[status.id];
    if (isLocalProvider(status.id)) {
      const model = pickLocalModel(status.modelos ?? []);
      return model ? [localProfile(status.id, model)] : [];
    }
    return [];
  }

  /** Cadastra um agente ACP de terceiros como provedor, com um perfil que o roda. */
  async addAcp(params: ProviderAcpAddParams): Promise<AgentProfile> {
    const id = params.id.trim();
    if (!isProviderId(id)) {
      throw RpcError.invalidParams(
        l10n.t('id must have only lowercase letters, numbers and hyphens'),
      );
    }
    if (isCliProvider(id) || isLocalProvider(id)) {
      throw RpcError.invalidParams(l10n.t('{0} is already an IDE provider; choose another id', id));
    }
    if (this.options.profiles().some((profile) => profile.id === id)) {
      throw RpcError.invalidParams(l10n.t('a profile {0} already exists', id));
    }
    const comando = params.comando.trim();
    if (!comando) throw RpcError.invalidParams(l10n.t('the agent command is missing'));
    const profile: AgentProfile = {
      id,
      nome: params.nome.trim() || id,
      provedor: id,
      adaptador: 'acp',
      comando,
      ...(params.args?.length ? { args: [...params.args] } : {}),
      ...(params.env && Object.keys(params.env).length > 0 ? { env: { ...params.env } } : {}),
      ...(params.chaveEnv ? { chaveEnv: params.chaveEnv } : {}),
      ...(params.modelo ? { modelo: params.modelo } : {}),
      pontosFortes: [l10n.t('ACP agent registered by the user')],
      custoRelativo: 'médio',
      podeSerMaestro: true,
    };
    if (!(await this.options.createProfile(profile))) {
      throw RpcError.invalidParams(l10n.t('a profile {0} already exists', id));
    }
    await this.options.reload?.();
    return profile;
  }

  register(router: Router): void {
    router.register('providers.detect', async (params): Promise<ProvidersDetectResult> => {
      const raw = params === undefined || params === null ? {} : objectParams(params);
      return {
        provedores: await this.detect({ versions: true, updates: raw.atualizacoes === true }),
      };
    });
    router.register('providers.environment', () => this.environment());
    router.register('providers.generateProfiles', (params) => {
      const raw = params === undefined || params === null ? {} : objectParams(params);
      const list = raw.provedores;
      if (
        list !== undefined &&
        (!Array.isArray(list) || !list.every((item) => typeof item === 'string'))
      ) {
        throw RpcError.invalidParams(l10n.t('provedores must be a list of ids'));
      }
      return this.generateProfiles(list);
    });
    router.register('providers.acp.add', (params) => {
      const p = objectParams(params);
      const text = (name: string): string | undefined =>
        typeof p[name] === 'string' ? p[name] : undefined;
      const args = p.args;
      if (
        args !== undefined &&
        (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))
      ) {
        throw RpcError.invalidParams(l10n.t('{0} must be a list of texts', 'args'));
      }
      const env = p.env;
      if (
        env !== undefined &&
        (typeof env !== 'object' ||
          env === null ||
          Array.isArray(env) ||
          !Object.values(env).every((value) => typeof value === 'string'))
      ) {
        throw RpcError.invalidParams(l10n.t('{0} must map names to texts', 'env'));
      }
      const chaveEnv = text('chaveEnv');
      const modelo = text('modelo');
      if (chaveEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(chaveEnv)) {
        throw RpcError.invalidParams(
          l10n.t('{0} must be the name of an environment variable', 'chaveEnv'),
        );
      }
      return this.addAcp({
        id: text('id') ?? '',
        nome: text('nome') ?? '',
        comando: text('comando') ?? '',
        ...(args ? { args } : {}),
        ...(env ? { env: env as Record<string, string> } : {}),
        ...(chaveEnv ? { chaveEnv } : {}),
        ...(modelo ? { modelo } : {}),
      });
    });
  }
}

/**
 * Pasta do Codex só para o login por chave de API (ADR 0041). O adaptador grava a chave
 * em `auth.json` dentro do `CODEX_HOME`; numa pasta própria, isso não sobrescreve o login
 * da assinatura que fica em `~/.codex`.
 */
export function codexKeyHome(home: string): string {
  return join(home, '.fakl', 'accounts', 'codex-chave');
}

/** Apaga a cópia da chave que o adaptador do Codex gravou na pasta própria. */
export function clearCodexKey(dir: string): void {
  rmSync(join(dir, 'auth.json'), { force: true });
}

/**
 * Variável e valor da chave de API que vão ao agente de um perfil, quando há chave no
 * cofre. Com `codexHome`, o agente do Codex também recebe a pasta própria como `CODEX_HOME`.
 */
export function providerKeyEnv(
  profile: AgentProfile,
  key: (name: `apikey.${string}`) => string | undefined,
  codexHome?: string,
): Record<string, string> {
  const value = key(apiKeySecretName(profile.provedor));
  if (!value) return {};
  const name =
    profile.chaveEnv ??
    (isCliProvider(profile.provedor) ? PROVIDER_KEY_ENV[profile.provedor] : undefined);
  if (!name) return {};
  return profile.provedor === 'openai' && codexHome
    ? { [name]: value, CODEX_HOME: codexHome }
    : { [name]: value };
}
