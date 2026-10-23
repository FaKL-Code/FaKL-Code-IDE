import type { ClaudeAccountRef, ClaudeAccountSlot } from './claude-accounts.js';
import type { SshRemoteRoot } from './integrations.js';

/**
 * Estados de uma sessão de agente (SDD 8.3). Os nomes vão nos eventos
 * `agent.state` e aparecem na mesa de controle, no café e no controle remoto.
 */
export const AGENT_STATES = [
  'preparando',
  'ocioso',
  'pensando',
  'executando',
  'aguardando-permissão',
  'aguardando-você',
  'pausado',
  'concluído',
  'falhou',
  'parado',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

/** Estados dos quais a sessão não sai mais. */
export const FINAL_AGENT_STATES: readonly AgentState[] = ['concluído', 'falhou', 'parado'];

export function isFinalAgentState(state: AgentState): boolean {
  return FINAL_AGENT_STATES.includes(state);
}

/** Resultado da detecção de um provedor ao abrir a IDE (SDD 8.2). */
export interface AdapterAvailability {
  readonly status: 'pronto' | 'não-instalado';
  /** Caminho do executável encontrado. */
  readonly path?: string;
  /** Comando que instala o que falta. */
  readonly install?: string;
}

/**
 * Modos de permissão de um agente (ADR 0016):
 * - `perguntar`: todo pedido do agente espera resposta;
 * - `aprovar-leitura`: leituras e buscas passam direto;
 * - `aprovar-tudo`: o agente não pergunta nada;
 * - `autopilot`: aprova tudo e também segue sozinho onde a IDE perguntaria,
 *   aplicando na pasta as mudanças sem conflito do chat e respondendo as
 *   decisões da execução pela opção segura.
 */
export const PERMISSION_MODES = [
  'perguntar',
  'aprovar-leitura',
  'aprovar-tudo',
  'autopilot',
] as const;
export type PermissionPolicyName = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionPolicyName {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Perfil de agente (SDD 7), guardado em `~/.fakl/profiles/<id>.yaml` e
 * sincronizado entre máquinas.
 */
export const AGENT_ADAPTERS = ['acp', 'ollama', 'terminal'] as const;
export type AgentAdapterName = (typeof AGENT_ADAPTERS)[number];

export interface AgentProfileDefinition {
  readonly id: string;
  readonly nome: string;
  /**
   * `anthropic`, `openai`, `google`, outro para agentes ACP de terceiros, ou
   * `ollama` e `lmstudio` para modelos locais.
   */
  readonly provedor: string;
  /**
   * `acp` para CLIs de agente; `ollama` para modelos locais pela API compatível com OpenAI;
   * `terminal` para qualquer CLI interativa, que roda num terminal do VS Code (ADR 0047).
   */
  readonly adaptador: AgentAdapterName;
  /** Adaptador `ollama`: endereço da API, como `http://127.0.0.1:11434/v1`. */
  readonly endpoint?: string;
  /** Executável do agente. Sem ele, vale o padrão do provedor. */
  readonly comando?: string;
  readonly args?: readonly string[];
  /** Variáveis extras do agente, sem segredos: chaves de API vão pelo cofre. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Agente ACP cadastrado: variável que recebe a chave de API guardada no cofre
   * para o provedor dele. Os provedores com CLI já sabem a sua.
   */
  readonly chaveEnv?: string;
  /** Modelo pedido ao agente; sem ele, vale o padrão da CLI. */
  readonly modelo?: string;
  /** No que o agente é bom; o maestro usa para escolher (SDD 9.1). */
  readonly pontosFortes?: readonly string[];
  readonly custoRelativo?: 'baixo' | 'médio' | 'alto';
  /** Regras que vão no início de toda conversa com o agente. */
  readonly regras?: readonly string[];
  readonly podeSerMaestro?: boolean;
  readonly ferramentasPermitidas?: readonly string[];
  /** Modo de permissão quando quem inicia o agente não escolhe; vence o do config.yaml. */
  readonly permissoes?: PermissionPolicyName;
  /** Adaptador `terminal`: como saber que a CLI terminou de trabalhar (heurística, ADR 0047). */
  readonly terminal?: TerminalProfileOptions;
}

/**
 * Heurística de "pronto" de um agente de terminal: a CLI está ociosa quando fica
 * `silencioSegundos` sem escrever e a última linha da tela casa com `prompt`.
 */
export interface TerminalProfileOptions {
  /** Expressão regular (sintaxe do JavaScript) da linha de prompt da CLI; sem ela vale só o silêncio. */
  readonly prompt?: string;
  /** Segundos sem saída para considerar a CLI ociosa; padrão 3. */
  readonly silencioSegundos?: number;
}

/** `profiles.list` e `profiles.get`: o perfil e o arquivo de onde veio. */
export interface AgentProfileEntry {
  readonly profile: AgentProfileDefinition;
  readonly arquivo: string;
}

/** Servidor MCP da configuração do usuário, entregue a todos os agentes (RF-006). */
export interface McpServerConfig {
  readonly nome: string;
  readonly comando: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Servidor MCP remoto (Streamable HTTP), instalado pela biblioteca de MCPs da IDE. */
export interface McpHttpServerConfig {
  readonly nome: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** O que o Core entrega a cada sessão: stdio do config.yaml e da biblioteca, ou HTTP. */
export type McpSessionServer = McpServerConfig | McpHttpServerConfig;

export function isMcpHttpServer(server: McpSessionServer): server is McpHttpServerConfig {
  return 'url' in server;
}

export interface AgentProfileAvailability {
  readonly id: string;
  readonly nome: string;
  readonly provedor: string;
  readonly availability: AdapterAvailability;
}

/** `agents.start`: abre uma sessão de agente avulsa, fora de uma execução. */
export interface AgentStartParams {
  readonly profileId: string;
  /** Pasta onde o agente trabalha, absoluta. */
  readonly cwd: string;
  readonly systemPrompt?: string;
  readonly permissions?: PermissionPolicyName;
  /**
   * Trabalhar num git worktree próprio, num branch `fakl/avulso/<sessão>`
   * (RF-105). Ao terminar, o trabalho fica commitado no branch.
   */
  readonly worktree?: boolean;
  /**
   * Raízes remotas (`fakl-ssh://`) abertas no workspace. O agente recebe host
   * e caminho no prompt e usa as ferramentas `ssh_*` para trabalhar nelas.
   */
  readonly remotas?: readonly SshRemoteRoot[];
  /** Perfis Claude: conta (slot) a usar; sem ela, vale a conta ativa (ADR 0022). */
  readonly contaClaude?: ClaudeAccountSlot;
}

export interface AgentWorktreeInfo {
  readonly path: string;
  readonly branch: string;
}

export interface AgentStartResult {
  readonly sessionId: string;
  readonly worktree?: AgentWorktreeInfo;
}

export interface AgentUsageInfo {
  /** Tudo o que foi enviado ao modelo, com o que veio do cache. */
  readonly inputTokens: number;
  /** A parte da entrada lida do cache, que custa um décimo; só quando o agente informa. */
  readonly cacheReadTokens?: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost?: { readonly amount: number; readonly currency: string };
  /** Janela de contexto, quando o agente informa (ACP `usage_update`). */
  readonly context?: { readonly used: number; readonly size: number };
  /**
   * O que a rodada atual gastou: chamadas de ferramenta e tokens de entrada
   * estimados (soma do contexto reenviado a cada requisição).
   */
  readonly turno?: { readonly passos: number; readonly entrada: number };
}

/** Espera por renovação da cota do provedor; automatização exige escolha explícita. */
export interface AgentRecoveryInfo {
  readonly motivo: 'limite-sessao';
  readonly mensagem: string;
  readonly retomarEm?: string;
  readonly automatica: boolean;
}

/** Evento `agent.recovery`; null é publicado antes de enviar a continuação. */
export interface AgentRecoveryEventData {
  readonly retomada: AgentRecoveryInfo | null;
}

/** `agents.setAutoResume`: preferência persistente da sessão. */
export interface AgentSetAutoResumeParams {
  readonly sessionId: string;
  readonly automatica: boolean;
}

/** Por que um agente parou: a conta ou o teto do provedor acabou (sessão de 5 h, semana, cota). */
export interface AgentLimitInfo {
  /** Primeira linha do aviso do agente. */
  readonly motivo: string;
  /** Quando o aviso chegou, ISO. */
  readonly em: string;
}

/** Avisos de erro dos agentes que dizem que a conta ou o teto acabou. */
const LIMIT_TEXT =
  /(usage|rate|session|weekly|daily)[ -]?limit|limit (reached|exceeded)|quota|limite (de uso|da sessão|semanal|diário|atingido)|teto diário/i;

export function isLimitText(text: string): boolean {
  return LIMIT_TEXT.test(text);
}

export interface AgentSessionInfo {
  readonly sessionId: string;
  /** Conversa simples: sem as ferramentas da IDE e fora do projeto. */
  readonly conversa?: boolean;
  readonly profileId: string;
  readonly nome: string;
  /** Provedor do perfil, para a marca e a cor do agente; ausente em Cores antigos. */
  readonly provedor?: string;
  /** Pasta onde o agente trabalha: o worktree, quando há. */
  readonly cwd: string;
  /** Pasta do projeto de onde a sessão saiu; difere de `cwd` quando há worktree. */
  readonly pastaOrigem?: string;
  readonly state: AgentState;
  readonly usage: AgentUsageInfo;
  readonly worktree?: AgentWorktreeInfo;
  readonly permissoes: PermissionPolicyName;
  /** Conta do Claude desta sessão, quando ela usa uma das contas da IDE. */
  readonly contaClaude?: ClaudeAccountRef;
  /** Opções que o agente oferece, como modelo e raciocínio; vazias se ele não oferece. */
  readonly opcoes: readonly AgentOptionInfo[];
  /** Título da conversa (a primeira mensagem); sessões guardadas em disco sempre têm. */
  readonly titulo?: string;
  /**
   * Sessão reidratada do disco, sem agente rodando: o chat mostra a conversa
   * inteira e uma nova mensagem retoma a sessão (ADR 0022).
   */
  readonly retomavel?: boolean;
  /** Tarefa da execução a que a sessão pertence; ausente numa conversa avulsa. */
  readonly taskId?: string;
  readonly retomada?: AgentRecoveryInfo;
  /** Horários ISO; ausentes em Cores anteriores a eles. */
  readonly iniciadaEm?: string;
  /** Último evento da sessão. */
  readonly atividadeEm?: string;
  /** Quando a sessão chegou a um estado final. */
  readonly encerradaEm?: string;
  /** Começo da última fala do agente, para as listas. */
  readonly ultimaFala?: string;
  /** Último aviso de limite do agente; some quando ele volta a trabalhar. */
  readonly limite?: AgentLimitInfo;
  /** Adaptador do perfil; ausente em Cores antigos (valem `acp`). */
  readonly adaptador?: AgentAdapterName;
  /** Id da sessão no próprio agente (ACP), para "Continuar no terminal". */
  readonly sessaoDoAgente?: string;
}

/** `agents.send`: mensagem para uma sessão viva. */
export interface AgentSendParams {
  readonly sessionId: string;
  readonly message: string;
  /**
   * O que a conversa mostra como mensagem do usuário, quando difere do que vai
   * ao agente (por exemplo, sem as respostas de outros agentes anexadas).
   */
  readonly exibir?: string;
}

/** Evento `agent.prompt`: uma mensagem foi para a sessão, do usuário ou do maestro. */
export interface AgentPromptEventData {
  readonly text: string;
}

/** Um item da conversa com um agente, como os chats da IDE e do celular mostram. */
export type ChatItem =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'agent'; readonly text: string }
  | { readonly kind: 'thought'; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly title: string;
      readonly status?: string;
      readonly toolKind?: string;
    }
  | {
      readonly kind: 'permission';
      readonly id: string;
      readonly title: string;
      /** Argumentos da chamada, um por linha (`comando: uptime`). */
      readonly detail?: string;
      readonly answer?: 'permitido' | 'negado';
    }
  | { readonly kind: 'notice'; readonly text: string; readonly tone: 'info' | 'error' };

/** `agents.transcript`: a conversa de uma sessão como o Core a montou. */
export interface AgentTranscriptParams {
  readonly sessionId: string;
  /** Últimos itens; padrão 300. */
  readonly limit?: number;
}

export interface AgentTranscriptResult {
  readonly items: readonly ChatItem[];
  /** Itens mais antigos deixados de fora pelo limite ou pelo tamanho. */
  readonly omitidos: number;
  /** Último evento aplicado; eventos ao vivo com id até este já estão nos itens. */
  readonly ultimoEvento?: string;
}

/**
 * Opção de uma sessão de agente que dá para trocar com ela viva: o modelo, o
 * nível de raciocínio ou outra que o agente ofereça (ACP `configOptions`).
 */
export interface AgentOptionInfo {
  readonly id: string;
  readonly nome: string;
  /** `model`, `thought_level`, `mode` ou outra; serve para a interface agrupar. */
  readonly categoria?: string;
  readonly descricao?: string;
  /** Valor atual: o id de um dos `valores`, ou um booleano. */
  readonly atual: string | boolean;
  /** Valores possíveis de uma opção de escolha; ausente num liga/desliga. */
  readonly valores?: readonly {
    readonly id: string;
    readonly nome: string;
    readonly descricao?: string;
  }[];
}

/** `agents.setOption`: troca uma opção da sessão, como o modelo. */
export interface AgentSetOptionParams {
  readonly sessionId: string;
  readonly id: string;
  readonly value: string | boolean;
}

/** Evento `agent.options`: as opções da sessão ou seus valores mudaram. */
export interface AgentOptionsEventData {
  readonly opcoes: readonly AgentOptionInfo[];
}

/** `agents.setPermissions`: troca o modo de uma sessão viva. */
export interface AgentSetPermissionsParams {
  readonly sessionId: string;
  readonly permissions: PermissionPolicyName;
}

/** Evento `agent.mode`: o modo de permissão da sessão mudou. */
export interface AgentModeEventData {
  readonly permissoes: PermissionPolicyName;
}

/** Evento `agent.answer`: um pedido de permissão foi respondido, por quem quer que seja. */
export interface AgentAnswerEventData {
  readonly id: string;
  readonly allow: boolean;
}

/** `agents.permission`: responde um pedido de permissão pendente. */
export interface AgentPermissionParams {
  readonly sessionId: string;
  readonly id: string;
  readonly allow: boolean;
  /** Com `allow`, vale também para os próximos pedidos iguais da sessão (`allow_always`). */
  readonly sempre?: boolean;
}

/**
 * Evento `agent.applied`: o autopilot aplicou as mudanças do worktree na pasta
 * do usuário. Não é mais publicado (ADR 0016, revisão); fica para as conversas antigas.
 */
export interface AgentAppliedEventData {
  readonly aplicados: readonly string[];
  /** Deixados para o usuário: aplicar daria conflito com o que ele mudou. */
  readonly pendentes: readonly string[];
}

/** Dados dos eventos `agent.*`; o `subject` é o id da sessão. */
export interface AgentStateEventData {
  readonly state: AgentState;
  readonly previous: AgentState;
  readonly reason?: string;
}

export interface AgentOutputEventData {
  readonly kind: 'message' | 'thought' | 'error';
  readonly text: string;
}

export interface AgentToolEventData {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
}

export interface AgentPermissionEventData {
  readonly id: string;
  readonly title: string;
  /** Argumentos da chamada, um por linha, para quem decide ver o que vai rodar. */
  readonly detail?: string;
  readonly options: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
  }[];
}

/** Pedido de permissão ainda sem resposta, para quem conecta depois do evento. */
export interface AgentPermissionRequest extends AgentPermissionEventData {
  readonly sessionId: string;
}

export interface AgentFileEventData {
  readonly path: string;
}

/** Um arquivo que o agente mudou (`agents.diff`, RF-107). */
export interface AgentChangedFile {
  readonly path: string;
  readonly status: 'adicionado' | 'modificado' | 'removido';
  readonly additions?: number;
  readonly deletions?: number;
  /** O que o usuário já fez com o arquivo nesta sessão. */
  readonly resolution?: 'aplicado' | 'rejeitado' | 'conflito';
}

export interface AgentDiffResult {
  /** Branch onde o trabalho do agente fica guardado. */
  readonly branch: string;
  /** Commit de partida. */
  readonly base: string;
  readonly files: readonly AgentChangedFile[];
}

/** `agents.fileContent`: conteúdo em base64; ausente se o arquivo não existe naquele lado. */
export interface AgentFileContentResult {
  readonly base64?: string;
}

export interface AgentApplyResult {
  readonly applied: readonly string[];
  readonly conflicts: readonly string[];
}

// Persistência das sessões (ADR 0022).

/** Um registro da conversa guardada de uma sessão, na ordem em que aconteceu. */
export type AgentTranscriptEntry =
  | { readonly t: 'user'; readonly text: string; readonly ts: string }
  | {
      readonly t: 'event';
      /** `agent.output`, `agent.tool`, `agent.permission`, `agent.answer`, `agent.applied` ou `agent.state`. */
      readonly topic: string;
      readonly data: unknown;
      readonly ts: string;
    };

/** `agents.forget`: apaga do disco uma sessão encerrada e a conversa dela. */
export interface AgentForgetParams {
  readonly sessionId: string;
}

/** Uma linha do terminal de leitura de um agente (ADR 0046), com cores ANSI simples. */
export interface AgentTerminalLine {
  /** Posição na sessão, crescente de 1 em 1; serve para não repetir linha ao reconectar. */
  readonly seq: number;
  /** Instante em que a linha foi fechada (ISO 8601). */
  readonly ts: string;
  readonly text: string;
}

/** Resposta de `agents.terminal.attach`: o histórico do buffer e o estado de agora. */
export interface AgentTerminalAttachResult {
  readonly sessionId: string;
  readonly lines: readonly AgentTerminalLine[];
  readonly state: AgentState;
  /** Linhas que já saíram do buffer circular antes das devolvidas. */
  readonly dropped: number;
}

/** Notificação `agents.terminal.lines`: linhas novas de uma sessão anexada. */
export interface AgentTerminalLinesParams {
  readonly sessionId: string;
  readonly lines: readonly AgentTerminalLine[];
  readonly state: AgentState;
}

/**
 * Ponte do agente de terminal (ADR 0047). O PTY vive na extensão `fakl-core`
 * (terminal do VS Code); o Core só fala com ela por estes métodos e comandos.
 */

/** `agents.terminalHost.register`: a extensão se oferece para hospedar terminais. */
export interface TerminalHostRegisterParams {
  /** Sessões cujo terminal esta extensão ainda mantém (reconexão). */
  readonly sessions?: readonly string[];
}

/** Estados que a extensão informa a partir do fluxo do terminal. */
export type TerminalReportedState = 'ocioso' | 'executando';

/** Corpo comum de `agents.terminalHost.output|state|exit|ready`. */
export interface TerminalHostReportParams {
  readonly sessionId: string;
  /** `output`: linhas já sem escapes ANSI, separadas por `
`. */
  readonly text?: string;
  /** `state`. */
  readonly state?: TerminalReportedState;
  /** `exit`: código de saída do comando, quando se sabe. */
  readonly code?: number;
  /** `exit`: motivo de uma falha que não é código de saída. */
  readonly error?: string;
}

/** Comando do Core para a extensão (notificação `agents.terminalHost.command`). */
export type TerminalHostCommand =
  | {
      readonly type: 'spawn';
      readonly sessionId: string;
      readonly nome: string;
      /** Vem do perfil; nada que o agente escreve vira comando. */
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly prompt?: string;
      readonly silencioSegundos?: number;
    }
  | { readonly type: 'input'; readonly sessionId: string; readonly text: string }
  | { readonly type: 'stop'; readonly sessionId: string };
