import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AgentProfile, McpServerRef } from '@fakl/agents';
import { currentLocale, l10n, useLocale } from '@fakl/i18n';
import {
  apiKeySecretName,
  CoreNotifications,
  type ClaudeAccountSlot,
  type ClaudeAccountUsage,
  type EventNotificationParams,
  type ReplayParams,
  type SubscribeResult,
} from '@fakl/protocol';

import { AgentSessionStore } from './agent-store.js';
import { AgentRuntime, type AgentRuntimeOptions } from './agents.js';
import { ClaudeAccounts } from './claude-accounts.js';
import { ConfigStore, type FirstRunInfo, type SemanticConfig, type VaultConfig } from './config.js';
import { CostTracker } from './costs.js';
import { EventBus, type Disposable } from './events/bus.js';
import type { HostPort } from './host.js';
import { GitHubService } from './integrations/github.js';
import { EmailService } from './integrations/email.js';
import { HostingerService } from './integrations/hostinger.js';
import { SshService } from './integrations/ssh.js';
import { TOOL_SETS, type ToolSetName } from './mcp/tools.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { chatMaestroPrompt, type ResourceSummary } from './orchestrator/prompts.js';
import { clearCodexKey, codexKeyHome, providerKeyEnv, ProviderService } from './providers.js';
import { providerSyncTarget, ResourceSync, type SyncTarget } from './resource-sync.js';
import { Economia } from './economia/economia.js';
import { EXPLORADOR, exploradorDe, exploradorPrompt } from './economia/explorador.js';
import { aspasSh, ganchosDaEconomia } from './economia/gancho.js';
import { FREIO_PADRAO } from './freio.js';
import { ajudaDaIde, guiaIndice, pesoDasFerramentas, promptDeConversa } from './guia.js';
import { Scorecard } from './scorecard.js';
import { UsageWindows } from './windows.js';
import { McpLibrary } from './mcp-library.js';
import { registerResourceFinder } from './resource-finder.js';
import { ResourceLibrary } from './resources.js';
import { ResourceSources } from './sources.js';
import { objectParams, Router, RpcError, stringArrayParam, stringParam } from './rpc/router.js';
import { RemoteGateway } from './remote/gateway.js';
import { RpcServer } from './rpc/server.js';
import { registerUi } from './ui.js';
import { EMBEDDINGS_SECRET, REMOTE_IDENTITY_SECRET, SecretVault } from './secrets.js';
import { Approvals } from './security/approvals.js';
import { CafeService } from './cafe.js';
import { CiService } from './ci.js';
import { ExternalSessionsService } from './external-sessions.js';
import { AuditLog } from './security/audit.js';
import { redactSecrets } from './security/scan.js';
import { AgentTokens } from './tokens.js';
import { ulid } from './ulid.js';
import { endpointHost } from './vault/semantic.js';
import { VaultService } from './vault/vault.js';
import { VozService } from './voz.js';

export const CORE_VERSION = '0.1.0';

export interface CoreOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly log?: (message: string) => void;
  /** O Core anterior caiu: retoma as execuções que ele deixou ativas (RNF-06). */
  readonly resumeInterrupted?: boolean;
  /** Processo principal da IDE, para onde vão os pedidos `ui.*` (ADR 0032). */
  readonly host?: HostPort;
  readonly agents?: AgentRuntimeOptions;
  /**
   * Pasta pessoal com `.fakl/profiles` e `.fakl/config.yaml`. Sem ela, valem
   * os perfis de `agents.profiles` ou os padrões, sem arquivos (testes).
   */
  readonly configHome?: string;
  /**
   * Como iniciar o servidor MCP `fakl` (maestro e vault); sem ele, não há
   * orquestração nem vault para os agentes.
   */
  readonly mcp?: McpLauncher;
  /** Nome desta máquina nos commits do vault; padrão, o hostname. */
  readonly machine?: string;
  /** `fetch` das integrações (GitHub, Hostinger); muda nos testes. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Executável do ssh; muda nos testes. */
  readonly sshCommand?: string;
  /**
   * Ambiente de onde saem `CLAUDE_CONFIG_DIR`, `CODEX_HOME` e `GEMINI_CLI_HOME`
   * padrão; sem ele, valem `.claude`, `.codex` e `.gemini` da pasta pessoal
   * (testes não tocam as reais).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Comando que inicia o servidor MCP `fakl` (dist/mcp.mjs). */
export interface McpLauncher {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface Core {
  readonly bus: EventBus;
  readonly agents: AgentRuntime;
  readonly config?: ConfigStore;
  readonly costs: CostTracker;
  /** Placar dos agentes por perfil (ADR 0043). */
  readonly scorecard: Scorecard;
  /** Modo econômico de tokens e o livro-caixa dele (ADR 0052). */
  readonly economia: Economia;
  readonly orchestrator: Orchestrator;
  readonly vault: VaultService;
  readonly remote?: RemoteGateway;
  readonly secrets: SecretVault;
  /** Provedores de IA prontos na máquina (ADR 0035). */
  readonly providers: ProviderService;
  readonly audit: AuditLog;
  readonly approvals: Approvals;
  readonly github: GitHubService;
  readonly email: EmailService;
  readonly ssh: SshService;
  readonly hostinger: HostingerService;
  readonly cafe: CafeService;
  /** Café do CI (ADR 0051). */
  readonly ci: CiService;
  /** Agentes e skills instalados na IDE; só com `configHome`. */
  readonly resources?: ResourceLibrary;
  /** Fontes de recursos cadastradas (repositórios git e pastas); só com `configHome`. */
  readonly sources?: ResourceSources;
  readonly router: Router;
  readonly server: RpcServer;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Token de sessão novo; o processo principal da IDE gera um a cada abertura. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

function registerEvents(router: Router, bus: EventBus): void {
  const subscriptions = new Map<string, Disposable>();

  router.register('events.subscribe', (params, context): SubscribeResult => {
    const topics = stringArrayParam(objectParams(params), 'topics');
    const subscriptionId = ulid();
    const subscription = bus.subscribe(topics, (event) => {
      const notification: EventNotificationParams = { subscriptionId, event };
      context.notify(CoreNotifications.event, notification);
    });
    subscriptions.set(subscriptionId, subscription);
    context.onClose(() => {
      subscription.dispose();
      subscriptions.delete(subscriptionId);
    });
    return { subscriptionId };
  });

  router.register('events.unsubscribe', (params) => {
    const subscriptionId = stringParam(objectParams(params), 'subscriptionId');
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription)
      throw RpcError.notFound(l10n.t('Subscription {0} does not exist', subscriptionId));
    subscription.dispose();
    subscriptions.delete(subscriptionId);
    return null;
  });

  router.register('events.replay', (params) => {
    const p = objectParams(params) as Partial<ReplayParams> & Record<string, unknown>;
    const topics = stringArrayParam(p, 'topics');
    const afterId = typeof p.afterId === 'string' ? p.afterId : undefined;
    const limit =
      typeof p.limit === 'number' && p.limit > 0 ? Math.min(p.limit, 10_000) : undefined;
    return bus.replay(topics, afterId, limit);
  });
}

/** `~/Vault` ou relativo: vira caminho absoluto a partir da pasta pessoal. */
function resolveVault(config: VaultConfig | undefined, home: string): VaultConfig | undefined {
  if (!config) return undefined;
  const raw = config.caminho;
  const caminho =
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
      ? join(home, raw.slice(1))
      : resolve(home, raw);
  return { ...config, caminho };
}

/** Monta o Core com os módulos disponíveis neste marco. */
export function createCore(options: CoreOptions): Core {
  const bus = new EventBus();
  const tokens = new AgentTokens();
  const secrets = new SecretVault();
  // Tirou a chave do Codex: some também a cópia que o adaptador gravou na pasta própria.
  secrets.onChange((name) => {
    if (name === apiKeySecretName('openai') && !secrets.has(name)) {
      clearCodexKey(codexKeyHome(options.configHome ?? homedir()));
    }
  });
  const email = new EmailService();
  const approvals = new Approvals(bus);
  const redact = (text: string): string => redactSecrets(text, secrets.all());
  // Ferramentas de integração de todo agente: escrita sempre passa por política e aprovação.
  const integrationSets = (): ToolSetName[] => [
    ...(vault.active ? (['vault'] as const) : []),
    ...(github.connected ? (['github'] as const) : []),
    ...(email.accountRefs().length > 0 ? (['email'] as const) : []),
    'ssh',
    'ide',
    ...(secrets.has('hostinger.token') ? (['hostinger'] as const) : []),
  ];
  // Servidor MCP `fakl` de uma sessão: um token que só abre os métodos das ferramentas pedidas.
  const mcpFor = (sessionId: string, wanted: readonly ToolSetName[]): McpServerRef[] => {
    const launcher = options.mcp;
    const sets = [...new Set(wanted)];
    if (!launcher || sets.length === 0) return [];
    const token = tokens.issue(sessionId, [
      ...sets.flatMap((set) => TOOL_SETS[set].map((tool) => tool.method)),
      'economia.registrar',
    ]);
    return [
      {
        name: 'fakl',
        command: launcher.command,
        args: [...launcher.args],
        env: {
          ...launcher.env,
          FAKL_CORE_SOCKET: options.socketPath,
          FAKL_AGENT_TOKEN: token,
          FAKL_MCP_TOOLS: sets.join(','),
          // Modo econômico vigente quando a sessão começa (ADR 0052).
          FAKL_ECONOMIA: economia.modo,
          // O servidor MCP responde aos agentes no idioma da IDE.
          FAKL_LOCALE: currentLocale(),
        },
      },
    ];
  };
  // Economia nas ferramentas do próprio Claude Code (ADR 0052): ganchos da sessão e
  // um explorador num modelo mais barato que o da conversa.
  const claudeMeta = (
    sessionId: string,
    profile: AgentProfile,
  ): Record<string, unknown> | undefined => {
    const launcher = options.mcp;
    const modo = economia.modo;
    if (!launcher || modo === 'desligado') return undefined;
    if (profile.provedor !== 'anthropic' || profile.adaptador !== 'acp') return undefined;
    const explorador = exploradorDe(profile, agents.profileList());
    // Vão no ambiente da sessão, que o gancho herda: na linha de comando, o Claude Code
    // grava o comando no transcrito, e o token iria junto.
    const env: Record<string, string> = {
      FAKL_ECONOMIA: modo,
      FAKL_LOCALE: currentLocale(),
      FAKL_CORE_SOCKET: options.socketPath,
      FAKL_AGENT_TOKEN: tokens.issue(sessionId, ['economia.registrar']),
      ...(explorador ? { FAKL_EXPLORADOR: EXPLORADOR } : {}),
    };
    // O Claude Code roda o gancho pelo sh (Git Bash no Windows), que aceita barras normais.
    const caminho = (valor: string): string =>
      aspasSh(process.platform === 'win32' ? valor.replace(/\\/g, '/') : valor);
    const comando = [
      ...Object.entries(launcher.env ?? {}).map(([name, value]) => `${name}=${aspasSh(value)}`),
      caminho(launcher.command),
      ...launcher.args.map(caminho),
      '--gancho',
    ].join(' ');
    return {
      claudeCode: {
        options: {
          env,
          settings: { hooks: ganchosDaEconomia(comando) },
          ...(explorador
            ? {
                agents: {
                  [EXPLORADOR]: {
                    description: l10n.t(
                      'Reads and searches the code to answer a question about it, on a cheaper model. Use it for exploration (where something is, how it works, what uses it) instead of reading many files yourself.',
                    ),
                    prompt: exploradorPrompt(),
                    tools: ['Read', 'Grep', 'Glob', 'Bash'],
                    model: explorador,
                  },
                },
              }
            : {}),
        },
      },
    };
  };
  const tokenCleanup = bus.subscribe(['agent.state'], (event) => {
    const state = (event.data as { state?: string }).state;
    if (state === 'concluído' || state === 'falhou' || state === 'parado') {
      tokens.revokeSession(event.subject);
      approvals.cancelSession(event.subject);
    }
  });
  const router = new Router();
  registerEvents(router, bus);
  router.register('guia.tema', (params) => ({
    texto: ajudaDaIde((params as { tema?: unknown } | undefined)?.tema),
  }));
  // Quanto as definições de ferramentas pesam em toda requisição de um agente do chat.
  router.register('guia.peso', async () => {
    const sets = options.mcp ? [...new Set<ToolSetName>(['orquestrar', ...integrationSets()])] : [];
    const servidores = mcps ? (await mcps.list()).servers.length : 0;
    return {
      ...pesoDasFerramentas(sets.flatMap((set) => TOOL_SETS[set])),
      servidoresMcp: servidores,
    };
  });
  const config: ConfigStore | undefined = options.configHome
    ? new ConfigStore({
        home: options.configHome,
        bus,
        // Primeira abertura: só ganham perfis os provedores prontos na máquina (ADR 0035).
        firstRun: async (): Promise<FirstRunInfo> => {
          const result = await providers.generateProfiles();
          return {
            provedores: result.provedores
              .filter((status) => status.pronto)
              .map((status) => status.id),
            perfis: config?.profiles ?? [],
          };
        },
        ...(options.log ? { log: options.log } : {}),
      })
    : undefined;
  config?.register(router);
  secrets.register(router);
  const dataDir = config ? join(config.dir, 'data') : undefined;
  // Contas do Claude (ADR 0021); o uso por conta vem dos custos, criados mais abaixo.
  const claudeAccounts = config
    ? new ClaudeAccounts({
        home: config.dir,
        ...(dataDir ? { file: join(dataDir, 'claude-accounts.json') } : {}),
        usage: () => {
          const bySlot: Partial<Record<ClaudeAccountSlot, ClaudeAccountUsage>> = {};
          const sessions = tracker.summary().porSessao;
          for (const [sessionId, slot] of agents.claudeSlots()) {
            const totals = sessions[sessionId];
            if (!totals) continue;
            const sum = bySlot[slot];
            bySlot[slot] = {
              tokensEntrada: (sum?.tokensEntrada ?? 0) + totals.tokensEntrada,
              tokensSaida: (sum?.tokensSaida ?? 0) + totals.tokensSaida,
              custoUsd: Math.round(((sum?.custoUsd ?? 0) + totals.custoUsd) * 1e6) / 1e6,
            };
          }
          return bySlot;
        },
        // Trocar a conta ativa troca também os agentes Claude abertos (ADR 0027).
        onSwitch: (slot) => agents.switchClaudeAccount(slot),
        publish: (data) => bus.publish('claude.account', 'claude', data),
        ...(options.log ? { log: options.log } : {}),
      })
    : undefined;
  claudeAccounts?.register(router);
  const providers: ProviderService = new ProviderService({
    profiles: () => agents.profileList(),
    createProfile: (profile) => config?.createProfile(profile) ?? Promise.resolve(false),
    ...(config ? { reload: () => config.reload() } : {}),
    hasKey: (provedor) => secrets.has(apiKeySecretName(provedor)),
    env: options.env ?? {},
    home: options.configHome ?? homedir(),
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(dataDir ? { stateFile: join(dataDir, 'providers.json') } : {}),
    ...(claudeAccounts
      ? {
          claudeAccountsLoggedIn: async () =>
            (await claudeAccounts.list()).contas.some((account) => account.logada === true),
        }
      : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  providers.register(router);
  // Sessão de 5 h e semana dos planos, lidas dos registros dos CLIs (ADR 0026).
  new UsageWindows({
    ...(claudeAccounts ? { accounts: () => claudeAccounts.list() } : {}),
    ...(options.configHome ? { home: options.configHome } : {}),
    // Provedor configurado sem registro local aparece como "sem dados".
    providers: () => [...new Set(agents.profileList().map((profile) => profile.provedor))],
  }).register(router);
  // Fontes de recursos (repositórios git ou pastas): de onde vêm agentes, skills e modelos de MCP.
  // A IDE não traz nenhum recurso; nada é instalado sem o usuário escolher.
  const sources = config
    ? new ResourceSources({
        dir: config.dir,
        gitEnv: () => github.gitEnv(),
        onChange: () => {
          void refreshResources().catch((error: unknown) => {
            options.log?.(l10n.t('could not re-read the resource sources: {0}', String(error)));
          });
        },
        ...(options.log ? { log: options.log } : {}),
      })
    : undefined;
  sources?.register(router);
  const sourceRoots = () => sources?.roots() ?? [];
  // Agentes e skills instalados na IDE, copiados para as CLIs dos provedores antes de cada sessão.
  let resourceSummary: ResourceSummary = { agents: [], skills: [] };
  const resources = config
    ? new ResourceLibrary({
        dir: join(config.dir, 'resources'),
        sources: sourceRoots,
        onChange: () => {
          void refreshResources()
            .then(() => resourceSync.refresh(configuredSyncTargets()))
            .catch((error: unknown) => {
              options.log?.(l10n.t('could not update the AI resources: {0}', String(error)));
            });
        },
        ...(options.log ? { log: options.log } : {}),
      })
    : undefined;
  resources?.register(router);
  const refreshResources = async (): Promise<void> => {
    const { agents, skills } = resources ? await resources.list() : { agents: [], skills: [] };
    const servers = mcps ? (await mcps.list()).servers : [];
    // Quantos itens as fontes oferecem: sem nenhum, o maestro nem ouve falar de recursos.
    let disponiveis = 0;
    if (sources && sources.size > 0) {
      const [offered, mcpOffered] = await Promise.all([
        resources?.catalog() ?? { agents: [], skills: [] },
        mcps?.catalog() ?? { servers: [] },
      ]);
      disponiveis = offered.agents.length + offered.skills.length + mcpOffered.servers.length;
    }
    resourceSummary = {
      agents,
      skills,
      ...(disponiveis > 0 ? { disponiveis } : {}),
      mcps: servers.map((server) => ({
        name: server.name,
        // O mcp.json é editável à mão: só texto vai ao prompt.
        description: typeof server.fakl?.descricao === 'string' ? server.fakl.descricao : '',
        ...(typeof server.fakl?.categoria === 'string' && server.fakl.categoria
          ? { categoria: server.fakl.categoria }
          : {}),
        ...(server.faltando.length > 0 ? { faltando: server.faltando } : {}),
      })),
    };
  };
  // Servidores MCP instalados na IDE (~/.fakl/mcp.json), além dos do config.yaml.
  const mcps = config
    ? new McpLibrary({
        file: join(config.dir, 'mcp.json'),
        sources: sourceRoots,
        vault: secrets,
        // O maestro vê no prompt os servidores instalados e os segredos que faltam.
        onChange: () => {
          void refreshResources().catch(() => undefined);
        },
        ...(options.log ? { log: options.log } : {}),
      })
    : undefined;
  mcps?.register(router);
  registerResourceFinder(router, {
    ...(resources ? { resources } : {}),
    ...(mcps ? { mcps } : {}),
  });
  secrets.onChange((name) => {
    if (!name.startsWith('mcp.')) return;
    void mcps
      ?.refresh()
      .then(() => refreshResources())
      .catch((error: unknown) => {
        options.log?.(l10n.t('could not re-read the MCP servers: {0}', String(error)));
      });
  });
  const resourceSync = new ResourceSync({
    items: async () => (resources ? await resources.list() : { agents: [], skills: [] }),
    ...(options.log ? { log: options.log } : {}),
  });
  const agentEnv = options.env ?? {};
  // Pastas das CLIs dos provedores configurados: o alvo do sync vem dos perfis, não de uma lista fixa.
  const configuredSyncTargets = (): SyncTarget[] => {
    const providers = new Set(agents.profileList().map((profile) => profile.provedor));
    return [...providers]
      .map((provedor) => providerSyncTarget(provedor, agentEnv, home))
      .filter((target): target is SyncTarget => !!target);
  };
  const audit = new AuditLog(dataDir ? join(dataDir, 'audit.jsonl') : undefined);
  audit.register(router);
  // O guarda consulta os custos, criados logo depois do runtime; só é chamado depois disso.
  const agents: AgentRuntime = new AgentRuntime(bus, {
    guard: (profile) => tracker.blockedReason(profile.provedor),
    ...(options.log ? { log: options.log } : {}),
    ...(config
      ? {
          ...(options.configHome ? { home: options.configHome } : {}),
          profiles: () => config.profiles,
          mcpServers: () => [...config.config.mcpServers, ...(mcps?.current() ?? [])],
          defaultPermissions: () => config.config.permissoes,
        }
      : {}),
    // Todo agente do chat chama outros agentes (Maestro Mode) e ganha o vault e as integrações.
    sessionMcp: (sessionId: string, profile: AgentProfile) =>
      orchestrator.sessionMcp(sessionId, profile) ??
      mcpFor(sessionId, ['orquestrar', ...integrationSets()]),
    freio: () => ({ ...FREIO_PADRAO, ...config?.config.freio }),
    sessionPrompt: () =>
      [
        options.mcp ? guiaIndice() : '',
        options.mcp
          ? chatMaestroPrompt(resourceSummary, agents.profileList(), economia.modo !== 'desligado')
          : '',
      ]
        .filter(Boolean)
        .join('\n\n') || undefined,
    conversaPrompt: () => promptDeConversa(),
    sessionMeta: claudeMeta,
    ...(resources
      ? {
          beforeStart: async (profile: AgentProfile, env: Readonly<Record<string, string>>) => {
            // A conta do Claude da sessão (CLAUDE_CONFIG_DIR) vence a do ambiente do Core.
            const target = providerSyncTarget(profile.provedor, { ...agentEnv, ...env }, home);
            if (target) await resourceSync.sync(target);
          },
        }
      : {}),
    // A chave de API do provedor vai só ao processo do agente dele (ADR 0035).
    providerEnv: (profile: AgentProfile) => {
      const codexHome = codexKeyHome(home);
      const env = providerKeyEnv(profile, (name) => secrets.get(name), codexHome);
      if (env.CODEX_HOME) mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      return env;
    },
    ...(claudeAccounts ? { claudeAccounts } : {}),
    approvals,
    redact,
    // Sessões e conversas dos agentes sobrevivem a reinícios do Core e a atualizações da IDE (ADR 0022).
    ...(dataDir
      ? {
          store: new AgentSessionStore({
            dir: join(dataDir, 'agents'),
            ...(options.log ? { log: options.log } : {}),
          }),
        }
      : {}),
    ...options.agents,
  });
  agents.register(router);
  const tracker: CostTracker = new CostTracker({
    bus,
    agents,
    ...(config ? { dataDir: join(config.dir, 'data') } : {}),
    caps: () => config?.config.tetoDiario ?? {},
    ...(config ? { setCaps: (caps) => config.setDailyCaps(caps) } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  tracker.register(router);
  const scorecard = new Scorecard({
    bus,
    sessionProfile: (sessionId) => agents.sessionProfile(sessionId),
    profileName: (id) => agents.profileList().find((p) => p.id === id)?.nome,
    profileExists: (id) => agents.profileList().some((p) => p.id === id),
    ...(dataDir ? { dataDir } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  scorecard.register(router);
  const economia = new Economia({
    modo: () => config?.config.economia ?? 'equilibrado',
    setModo: async (modo) => {
      await config?.setEconomia(modo);
    },
    ...(dataDir ? { dataDir } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  economia.register(router);
  const orchestrator = new Orchestrator({
    bus,
    agents,
    costs: tracker,
    scorecard,
    economia,
    profiles: () => agents.profileList(),
    defaults: () => ({
      ...(config?.config.limites ? { limites: config.config.limites } : {}),
      ...(config?.config.entrega ? { entrega: config.config.entrega } : {}),
      ...(config?.config.buildAposMerge ? { buildAposMerge: config.config.buildAposMerge } : {}),
    }),
    ...(config ? { dataDir: join(config.dir, 'data') } : {}),
    ...(options.mcp
      ? {
          mcpFor: (sessionId: string, sets: readonly ToolSetName[]) =>
            mcpFor(sessionId, [...sets.filter((set) => set !== 'vault'), ...integrationSets()]),
        }
      : {}),
    github: {
      get connected() {
        return github.connected;
      },
      gitEnv: () => github.gitEnv(),
      createPull: (repoRoot, pull) => github.createPull(repoRoot, pull),
      mergePull: (repoRoot, number, title) => github.mergePull(repoRoot, number, title),
      dispatchWorkflow: (repoRoot, workflow, ref, inputs) =>
        github.dispatchWorkflow(repoRoot, workflow, ref, inputs),
    },
    lovable: (repoRoot) => lovableFor(repoRoot),
    maestroContext: (repoRoot) => maestroContext(repoRoot),
    resources: () => resourceSummary,
    ...(resources ? { resource: (kind, name) => resources.get(kind, name) } : {}),
    knownSecrets: () => secrets.all(),
    ...(options.log ? { log: options.log } : {}),
  });
  orchestrator.register(router);
  // O café mostra a cozinha do CI; o serviço nasce depois do GitHub e entra por esta ponte.
  const ciBridge: { service?: CiService } = {};
  const cafe = new CafeService({
    bus,
    agents,
    orchestrator,
    costs: tracker,
    ci: () => (ciBridge.service?.active ? ciBridge.service.status() : undefined),
  });
  cafe.register(router);
  new ExternalSessionsService({
    home: options.configHome ?? homedir(),
    env: options.env ?? {},
    enabled: () => config?.config.sessoesExternas === true,
    ...(config
      ? {
          save: async (enabled: boolean) => {
            await config.setExternalSessions(enabled);
            await config.reload();
          },
        }
      : {}),
    redact,
  }).register(router);
  const guards = { approvals, audit };
  const github: GitHubService = new GitHubService({
    ...guards,
    secrets,
    agents,
    createTask: async (definition, start) => {
      const task = await orchestrator.createTask(definition);
      return start ? { task, run: await orchestrator.startRun(task.id) } : { task };
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  github.register(router);
  const ci = new CiService({
    bus,
    source: {
      get connected() {
        return github.connected;
      },
      runs: (repo, perPage) => github.client.runs(repo, undefined, perPage),
      jobs: (repo, runId) => github.client.jobs(repo, runId),
      repoOf: (path) => github.repoOf(path),
      limitedUntil: () => github.client.limitedUntil(),
    },
    ...(options.log ? { log: options.log } : {}),
  });
  ciBridge.service = ci;
  ci.register(router);
  // Conectar ou sair da conta do GitHub liga ou desliga a consulta do CI.
  secrets.onChange((name) => {
    if (name === 'github.token') ci.reconnected();
  });
  email.register(router);
  new VozService({
    config: () => config?.config.voz,
    ...(config ? { save: (change) => config.setVoz(change) } : {}),
    secrets,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }).register(router);
  const ssh: SshService = new SshService({
    ...guards,
    ...(options.configHome ? { home: options.configHome } : {}),
    ...(dataDir ? { file: join(dataDir, 'ssh-hosts.json') } : {}),
    ...(dataDir ? { forwardsFile: join(dataDir, 'ssh-forwards.json') } : {}),
    onForward: (info) => bus.publish('ssh.forward', 'ssh', info),
    beforeWrite: (host) => hostinger.snapshotBeforeWrite(host),
    redact,
    ...(options.sshCommand ? { sshCommand: options.sshCommand } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  ssh.register(router);
  const hostinger: HostingerService = new HostingerService({
    ...guards,
    secrets,
    ssh,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  hostinger.register(router);
  // Projetos Lovable (SDD 11.4): pelo origin do repositório.
  const lovableFor = async (
    repoRoot: string,
  ): Promise<{ url: string; branch: string } | undefined> => {
    const projects = config?.config.lovable ?? [];
    if (projects.length === 0) return undefined;
    const repo = await github.repoOf(repoRoot);
    if (!repo) return undefined;
    const name = `${repo.owner}/${repo.name}`.toLowerCase();
    const project = projects.find((p) => p.repo.toLowerCase() === name);
    return project ? { url: project.url, branch: project.branch ?? 'main' } : undefined;
  };
  const maestroContext = async (repoRoot: string): Promise<string[]> => {
    const sections: string[] = [];
    const sets = integrationSets().filter((set) => set !== 'vault');
    if (sets.length > 0) {
      sections.push(
        l10n.t(
          "Integrations available to you and your subagents on the `fakl` server: {0}. Write actions (commenting, DNS, commands on servers) require the user's approval; prefer reading before acting.",
          sets.join(', '),
        ),
      );
    }
    const lovable = await lovableFor(repoRoot);
    if (lovable) {
      sections.push(
        l10n.t(
          'This repository is a Lovable project ({0}), synced through the {1} branch. On merge delivery, the Core pushes that branch to GitHub and Lovable shows the change. If a visual change is better made in Lovable itself, call ask_human with a prompt ready to paste there instead of implementing it.',
          lovable.url,
          lovable.branch,
        ),
      );
    }
    return sections;
  };
  router.register('lovable.list', () => config?.config.lovable ?? []);
  router.register('lovable.set', async (params) => {
    if (!config) throw RpcError.invalidParams(l10n.t('Settings unavailable'));
    const p = objectParams(params);
    if (!Array.isArray(p.projetos)) throw RpcError.invalidParams(l10n.t('projetos must be a list'));
    try {
      await config.setLovable(p.projetos as never);
    } catch (error) {
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
    return config.config.lovable ?? [];
  });
  const home = options.configHome ?? homedir();
  const vault: VaultService = new VaultService({
    bus,
    config: () => resolveVault(config?.config.vault, home),
    costs: tracker,
    orchestrator,
    redact,
    embeddingsKey: () => secrets.get(EMBEDDINGS_SECRET),
    economizou: ({ itens, caracteres }) => {
      economia.registrar({ embeddingsEvitados: itens, caracteresEmbeddings: caracteres });
    },
    ...(dataDir ? { dataDir } : {}),
    ...(options.machine ? { machine: options.machine } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  vault.register(router);
  secrets.onChange((name) => {
    if (name === EMBEDDINGS_SECRET) vault.embeddingsKeyChanged();
  });
  router.register('vault.configureSemantic', async (params, context) => {
    // Escolher o servidor e confirmar o envio das notas é decisão da pessoa, na IDE.
    if (context.principal !== undefined) {
      throw RpcError.invalidParams(l10n.t('only the IDE configures semantic search'));
    }
    if (!config) throw RpcError.invalidParams(l10n.t('Settings unavailable'));
    const current = config.config.vault;
    if (!current)
      throw RpcError.invalidParams(l10n.t('No vault configured; set vault.caminho in config.yaml'));
    const p = objectParams(params);
    const rest = {
      caminho: current.caminho,
      ...(current.remoto ? { remoto: current.remoto } : {}),
      ...(current.sincronizar !== undefined ? { sincronizar: current.sincronizar } : {}),
    };
    let semantica: SemanticConfig | undefined;
    if (p.provedor !== null) {
      const provedor = stringParam(p, 'provedor');
      const modelo = stringParam(p, 'modelo');
      const endpoint = typeof p.endpoint === 'string' && p.endpoint ? p.endpoint : undefined;
      // Confirmar vale para o servidor do endpoint de agora; trocar de servidor pede de novo.
      const confirmar = p.confirmar === true && provedor === 'openai' && endpoint;
      semantica = {
        provedor: provedor as SemanticConfig['provedor'],
        modelo,
        ...(endpoint ? { endpoint } : {}),
        ...(confirmar ? { confirmadoPara: endpointHost(endpoint) } : {}),
      };
    }
    try {
      await config.setVault({ ...rest, ...(semantica ? { semantica } : {}) });
    } catch (error) {
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
    await reopenVault();
    return vault.status();
  });
  router.register('vault.configure', async (params) => {
    if (!config) throw RpcError.invalidParams(l10n.t('Settings unavailable'));
    const p = objectParams(params);
    if (p.caminho === null) {
      await config.setVault(undefined);
    } else {
      const caminho = stringParam(p, 'caminho');
      const remoto = typeof p.remoto === 'string' && p.remoto ? p.remoto : undefined;
      // Mantém o resto de `vault:` (sincronizar, semantica) ao trocar pasta ou remoto.
      const current = config.config.vault;
      const rest = {
        ...(current?.sincronizar !== undefined ? { sincronizar: current.sincronizar } : {}),
        ...(current?.semantica ? { semantica: current.semantica } : {}),
      };
      try {
        await config.setVault({ ...rest, caminho, ...(remoto ? { remoto } : {}) });
      } catch (error) {
        throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
      }
    }
    await reopenVault();
    return vault.status();
  });
  // Reabre o vault quando a configuração dele muda.
  let vaultKey = '';
  let vaultOpening: Promise<void> = Promise.resolve();
  const reopenVault = (): Promise<void> => {
    const key = JSON.stringify(config?.config.vault ?? null);
    if (key === vaultKey) return vaultOpening;
    vaultKey = key;
    vaultOpening = vaultOpening
      .then(() => vault.flush())
      .then(() => vault.open())
      .catch((error: unknown) => {
        options.log?.(l10n.t('could not open the vault: {0}', String(error)));
      });
    return vaultOpening;
  };
  const vaultWatch = bus.subscribe(['config.changed'], () => void reopenVault());
  registerUi(router, bus, options.host);
  const server = new RpcServer({
    router,
    token: options.token,
    coreVersion: CORE_VERSION,
    scopedToken: (token) => tokens.access(token),
    onLocale: (locale) => useLocale(locale),
    locale: currentLocale,
    ...(options.log ? { log: options.log } : {}),
  });
  const remote = config
    ? new RemoteGateway({
        bus,
        server,
        dir: join(config.dir, 'remote'),
        config: () => config.config.remoto,
        saveConfig: (change) => config.setRemote(change),
        identityKey: () => secrets.get(REMOTE_IDENTITY_SECRET),
        ...(options.log ? { log: options.log } : {}),
      })
    : undefined;
  remote?.register(router);
  secrets.onChange((name) => {
    if (name === REMOTE_IDENTITY_SECRET) remote?.keyChanged();
  });

  return {
    bus,
    agents,
    ...(config ? { config } : {}),
    costs: tracker,
    scorecard,
    economia,
    orchestrator,
    vault,
    ...(remote ? { remote } : {}),
    secrets,
    providers,
    audit,
    approvals,
    github,
    email,
    ssh,
    hostinger,
    cafe,
    ci,
    ...(resources ? { resources } : {}),
    ...(sources ? { sources } : {}),
    router,
    server,
    start: async () => {
      if (config) {
        await config.load();
        config.watch();
      }
      await tracker.load();
      await scorecard.load();
      await economia.load();
      await claudeAccounts?.init();
      await sources?.load().catch((error: unknown) => {
        options.log?.(l10n.t('could not read the resource sources: {0}', String(error)));
      });
      // Repositório cadastrado em outra máquina (sources.json copiado) é baixado sem travar a abertura.
      void sources?.ensureClones().catch((error: unknown) => {
        options.log?.(l10n.t('could not download the resource sources: {0}', String(error)));
      });
      await resources?.init().catch((error: unknown) => {
        options.log?.(l10n.t('could not prepare the AI resources: {0}', String(error)));
      });
      await refreshResources().catch(() => undefined);
      await mcps?.refresh().catch((error: unknown) => {
        options.log?.(l10n.t('could not read the MCP servers: {0}', String(error)));
      });
      await audit.load();
      await ssh.load();
      await orchestrator.load();
      await agents.load();
      await reopenVault();
      await server.listen(options.socketPath);
      // Sem await: o gateway espera a chave da identidade que a IDE entrega
      // (ADR 0044) e isso não pode atrasar a abertura do Core.
      void remote?.start().catch((error: unknown) => {
        options.log?.(l10n.t('could not enable remote access: {0}', String(error)));
      });
      if (options.resumeInterrupted) {
        const resumed = await orchestrator.resumeInterrupted();
        if (resumed.length > 0)
          options.log?.(l10n.t('resumed after the crash: {0}', resumed.join(', ')));
      }
    },
    stop: async () => {
      remote?.dispose();
      await ssh.closeForwards();
      config?.dispose();
      vaultWatch.dispose();
      cafe.dispose();
      ci.dispose();
      orchestrator.dispose();
      approvals.dispose();
      await agents.stopAll();
      // Execuções terminando ainda gravam tarefa e execução; prazo curto para não travar.
      await Promise.race([
        orchestrator.settle(),
        new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
      ]);
      await vault.flush();
      vault.dispose();
      tokenCleanup.dispose();
      tracker.dispose();
      await tracker.flush();
      scorecard.dispose();
      await scorecard.flush();
      economia.dispose();
      await economia.flush();
      await audit.flush();
      await server.close();
    },
  };
}
