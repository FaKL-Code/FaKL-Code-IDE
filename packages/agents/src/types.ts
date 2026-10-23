import type {
  AdapterAvailability,
  AgentOptionInfo,
  AgentProfileDefinition,
  AgentState,
} from '@fakl/protocol';

/** Perfil de agente (SDD 7); o runtime usa comando, args, modelo e regras. */
export type AgentProfile = AgentProfileDefinition;

/**
 * Servidor MCP entregue ao agente na criação da sessão. Nos textos,
 * `${workspaceFolder}` vira o diretório do agente e `${userHome}` a pasta do usuário.
 */
export interface McpStdioServerRef {
  readonly type?: 'stdio';
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Servidor MCP remoto; só vai a agentes que anunciam `mcpCapabilities.http`. */
export interface McpHttpServerRef {
  readonly type: 'http';
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type McpServerRef = McpStdioServerRef | McpHttpServerRef;

/**
 * - `perguntar`: todo pedido de permissão vira evento e espera resposta.
 * - `aprovar-leitura`: leituras e buscas passam direto; o resto pergunta.
 * - `aprovar-tudo`: aprova tudo sem perguntar.
 */
export type PermissionPolicy = 'perguntar' | 'aprovar-leitura' | 'aprovar-tudo';

export interface StartOptions {
  readonly profile: AgentProfile;
  /** Worktree do agente; o agente só lê e grava arquivos dentro dele. */
  readonly cwd: string;
  /**
   * Variáveis extras; o único segredo aqui é a chave de API do provedor do
   * perfil, quando o usuário guardou uma (ADR 0035). O ambiente do usuário
   * passa por lista de permissão.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly mcpServers?: readonly McpServerRef[];
  /** Papel, regras do perfil e contexto da tarefa; vai antes da primeira mensagem. */
  readonly systemPrompt?: string;
  readonly permissions: PermissionPolicy;
  /** Retoma uma sessão que já existiu (Core reiniciado): tenta o id do agente, senão recria com o histórico. */
  readonly resume?: ResumeOptions;
  /**
   * `_meta` da criação da sessão ACP, para o que só um agente entende (o adaptador
   * do Claude lê `claudeCode.options`: ganchos, subagentes, ambiente).
   */
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
}

export interface ResumeOptions {
  /** Id da sessão no agente (ACP), guardado quando ela foi criada. */
  readonly sessionId?: string;
  /** Conversa anterior em texto, usada como contexto quando o agente não consegue retomar a sessão. */
  readonly history?: string;
}

/** Como uma sessão retomada voltou: pela sessão do próprio agente ou recriada com o histórico. */
export type ResumeKind = 'sessão' | 'histórico';

export interface Usage {
  /** Tudo o que foi enviado ao modelo, com o que veio do cache. */
  readonly inputTokens: number;
  /** A parte da entrada lida do cache, que custa um décimo; só quando o agente informa. */
  readonly cacheReadTokens?: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Custo acumulado informado pelo agente, quando ele informa. */
  readonly cost?: { readonly amount: number; readonly currency: string };
  /** Janela de contexto: tokens ocupados agora e o tamanho dela. */
  readonly context?: { readonly used: number; readonly size: number };
}

export interface PermissionOptionInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export type AgentEvent =
  | {
      readonly type: 'state';
      readonly state: AgentState;
      readonly previous: AgentState;
      /** Só em `parado`. */
      readonly reason?: StopReason;
    }
  | { readonly type: 'output'; readonly kind: 'message' | 'thought'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly toolCallId: string;
      readonly title?: string;
      /** Impressão digital dos argumentos: a mesma chamada repetida tem a mesma. */
      readonly input?: string;
      readonly kind?: string;
      readonly status?: string;
    }
  | {
      readonly type: 'permission';
      readonly id: string;
      readonly title: string;
      /** Argumentos da chamada, um por linha. */
      readonly detail?: string;
      readonly options: readonly PermissionOptionInfo[];
    }
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'options'; readonly options: readonly AgentOptionInfo[] }
  | { readonly type: 'error'; readonly message: string };

export type StopReason = 'usuário' | 'ide-fechando' | 'limite' | 'maestro';

export interface Disposable {
  dispose(): void;
}

export interface AgentHandle {
  readonly state: AgentState;
  /** Id da sessão no próprio agente (ACP), para retomá-la depois que o Core reiniciar. */
  readonly remoteSessionId?: string | undefined;
  /** Só em sessões abertas com `resume`. */
  readonly resumedAs?: ResumeKind | undefined;
  /** Manda uma mensagem. Se o agente estiver ocupado, entra na fila. Resolve quando a rodada dela termina. */
  send(message: string): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): Disposable;
  /** Responde um pedido; com `always`, pede ao agente para lembrar a resposta na sessão (ACP `allow_always`). */
  respondPermission(id: string, allow: boolean, always?: boolean): Promise<void>;
  /** Troca a política com a sessão viva; vale para os próximos pedidos. */
  setPermissions(policy: PermissionPolicy): void;
  /** Opções que o agente oferece agora, como modelo e raciocínio. */
  sessionOptions(): readonly AgentOptionInfo[];
  /** Troca uma opção; vale a partir da próxima mensagem. */
  setOption(id: string, value: string | boolean): Promise<void>;
  pause(): Promise<void>;
  /**
   * Volta da pausa. Uma vez interrompida recomeça com "continue de onde parou";
   * `continuar: false` descarta isso, para a próxima mensagem começar a rodada.
   */
  resume(continuar?: boolean): Promise<void>;
  stop(reason: StopReason): Promise<void>;
  usage(): Usage;
}

export interface AgentAdapter {
  readonly id: string;
  /** CLI instalada? O login só é conferido ao iniciar, porque cada CLI guarda o seu de um jeito. */
  detect(): Promise<AdapterAvailability>;
  start(options: StartOptions): Promise<AgentHandle>;
}
