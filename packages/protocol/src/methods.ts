/**
 * Catálogo de métodos da API local do Core (SDD 6.3). Os nomes seguem
 * `domínio.ação` e são os mesmos para extensões, CLI e controle remoto; o que
 * muda entre eles é o escopo do token de sessão.
 */
export const CoreMethods = {
  /** Abertura de sessão: o primeiro pedido de toda conexão (SDD 4.1). */
  session: ['hello'],
  profiles: ['list', 'get', 'upsert', 'delete'],
  /** Opções gerais do config.yaml que a jornada de configuração muda pela IDE. */
  config: ['permissions.get', 'permissions.set'],
  /**
   * Provedores de IA (ADR 0035): o que está instalado, logado, com chave ou
   * rodando local; a jornada de configuração começa por aqui.
   */
  providers: ['detect', 'environment', 'generateProfiles', 'acp.add'],
  tasks: ['create', 'list', 'get', 'cancel', 'fromIssue', 'fromNote'],
  runs: ['start', 'pause', 'resume', 'setAutoResume', 'stop', 'get', 'tree', 'decide', 'decisions'],
  agents: [
    'detect',
    'start',
    'list',
    'send',
    'pause',
    'resume',
    'setAutoResume',
    'stop',
    // Terminal de leitura de cada agente (ADR 0046): histórico e linhas novas.
    'terminal.attach',
    'terminal.detach',
    'diff',
    'fileContent',
    'applyFiles',
    'rejectFiles',
    'permission',
    'permissions',
    'setPermissions',
    'setOption',
    // Sessões guardadas em disco (ADR 0022).
    'transcript',
    'forget',
  ],
  playbooks: ['list', 'get', 'run'],
  /** Ferramentas do maestro (SDD 9.1), chamadas pelo servidor MCP `fakl` com o token do agente. */
  maestro: [
    'listProfiles',
    'spawnAgent',
    'sendMessage',
    'awaitResults',
    'reviewDiff',
    'runChecks',
    'mergeWork',
    'stopAgent',
    'askHuman',
    'finish',
    // Perfil sugerido para uma tarefa, pela camada de custo (ADR 0052).
    'suggestProfile',
  ],
  vault: [
    'status',
    'search',
    'semanticSearch',
    'read',
    'write',
    'backlinks',
    'graph',
    'tags',
    'sync',
    'appendDaily',
    'daily',
    'configure',
  ],
  /** GitHub no Core: ferramentas dos agentes e o credential helper (SDD 11.1). */
  github: [
    'status',
    'gitCredential',
    'repo',
    'issues.list',
    'issues.get',
    'issues.comment',
    'prs.list',
    'prs.get',
    'prs.create',
    'actions.list',
    'actions.logs',
    // Visão da conta inteira, sem depender de um repositório (ADR 0020).
    'account.repos.list',
    'account.orgs.list',
    'account.prs.mine',
    'account.prs.reviewRequested',
    'account.prs.assigned',
    'account.issues.mine',
    'account.actions.recent',
    'account.notifications.list',
    'account.notifications.markRead',
  ],
  /** Caixas IMAP configuradas na IDE; credenciais nunca são entregues aos agentes. */
  email: ['configure', 'accounts', 'verify', 'inbox', 'read'],
  ssh: ['hosts.list', 'hosts.upsert', 'hosts.delete', 'exec', 'read', 'write', 'list', 'stat'],
  hostinger: [
    'status',
    'vps.list',
    'vps.restart',
    'vps.snapshot',
    'dns.list',
    'dns.upsert',
    'dns.delete',
    'domains.list',
    'firewall.list',
    'firewall.create',
    'firewall.delete',
    'firewall.rule.upsert',
    'firewall.rule.delete',
    'firewall.attach',
  ],
  /** Contas do Claude lado a lado, cada uma com sua pasta de configuração (ADR 0021). */
  claude: [
    'accounts.list',
    'accounts.prepare',
    'accounts.rename',
    'accounts.setActive',
    'accounts.logout',
  ],
  lovable: ['list', 'set'],
  /** Agentes e skills instalados na IDE (`~/.fakl/resources`) e os oferecidos pelas fontes. */
  resources: ['list', 'catalog', 'install', 'create', 'remove', 'get', 'find'],
  /** Servidores MCP da IDE (`~/.fakl/mcp.json`) e modelos das fontes. */
  mcps: ['list', 'catalog', 'install', 'remove'],
  /** Fontes de recursos: repositórios git ou pastas com agentes, skills e modelos de MCP. */
  sources: ['list', 'add', 'remove', 'update'],
  /** Segredos que a IDE entrega ao Core a cada abertura (ADR 0010). */
  secrets: ['set', 'status'],
  audit: ['list', 'verify'],
  /** Cyber café (SDD 13): liga as miniaturas enquanto a sala está aberta. */
  cafe: ['open', 'close', 'state'],
  /** Café do CI (ADR 0051): runs do GitHub Actions dos repositórios acompanhados. */
  ci: ['status', 'watch.set'],
  /** Conversas das extensões do Codex e do Claude Code, só leitura e só com consentimento (ADR 0039). */
  external: ['status', 'setEnabled', 'list'],
  remote: [
    'status',
    /** Confere o relay (HTTPS, WebSocket e chave) sem mexer na conexão; a jornada usa. */
    'test',
    'enable',
    'disable',
    'pair.begin',
    'pair.confirm',
    'pair.cancel',
    'devices.list',
    'devices.revoke',
    'devices.update',
    'push.subscribe',
    'push.unsubscribe',
  ],
  /** Placar dos agentes por perfil (ADR 0043). */
  scorecard: ['get', 'reset'],
  /** Modo econômico de tokens (ADR 0052): modo, livro-caixa e o registro que o servidor MCP do agente envia. */
  economia: ['status', 'setModo', 'registrar', 'reset'],
  costs: ['summary', 'byTask', 'limits.get', 'limits.set'],
  /** Sessão de 5 h e limite semanal dos planos (ADR 0026). */
  usage: ['windows'],
  events: ['subscribe', 'unsubscribe', 'replay'],
  /** Comandos por voz (ADR 0031): o modo escolhido e a transcrição do áudio no Core. */
  voz: ['status', 'configurar', 'transcrever'],
  /** Modo minimizado (ADR 0032): só a IDE e o overlay chamam; agentes e celular não. */
  ui: ['reveal', 'takeReveal', 'overlay'],
} as const;

export type CoreDomain = keyof typeof CoreMethods;

/** Notificações que o Core envia aos clientes. */
export const CoreNotifications = {
  /** Um evento de um tópico assinado com `events.subscribe`. */
  event: 'events.event',
  /** Linhas novas do terminal de um agente anexado com `agents.terminal.attach`. */
  terminalLines: 'agents.terminal.lines',
} as const;

/** Nome completo de um método, por exemplo `runs.start` ou `agents.terminal.attach`. */
export type CoreMethod = {
  [D in CoreDomain]: `${D}.${(typeof CoreMethods)[D][number]}`;
}[CoreDomain];

export const ALL_CORE_METHODS: readonly CoreMethod[] = (
  Object.entries(CoreMethods) as [CoreDomain, readonly string[]][]
).flatMap(([domain, actions]) => actions.map((action) => `${domain}.${action}` as CoreMethod));

const methodSet: ReadonlySet<string> = new Set(ALL_CORE_METHODS);

export function isCoreMethod(name: string): name is CoreMethod {
  return methodSet.has(name);
}

/** Separa `agents.terminal.attach` em domínio `agents` e ação `terminal.attach`. */
export function splitMethod(name: CoreMethod): { domain: CoreDomain; action: string } {
  const dot = name.indexOf('.');
  return { domain: name.slice(0, dot) as CoreDomain, action: name.slice(dot + 1) };
}
