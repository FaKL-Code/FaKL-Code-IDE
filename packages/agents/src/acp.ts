import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';
import { l10n } from '@fakl/i18n';
import {
  isFinalAgentState,
  type AdapterAvailability,
  type AgentOptionInfo,
  type AgentState,
} from '@fakl/protocol';
import spawn from 'cross-spawn';

import { agentEnv } from './env.js';
import { prepareMcpServers } from './mcp-servers.js';
import { toolInputKey } from './tool-input.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  Disposable,
  PermissionPolicy,
  ResumeKind,
  StartOptions,
  StopReason,
  Usage,
} from './types.js';
import { findExecutable } from './which.js';

/** Como iniciar um agente ACP: executável, argumentos e dicas para o usuário. */
export interface AcpCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Variáveis extras do agente, como o modelo pedido no perfil. */
  readonly env?: Readonly<Record<string, string>>;
  /** Comando que instala o agente, mostrado quando ele não é encontrado. */
  readonly install?: string;
  /** Como fazer login, mostrado quando o agente pede autenticação. */
  readonly login?: string;
  /** Quanto esperar o agente responder ao iniciar a sessão; padrão 90 s. */
  readonly startTimeoutMs?: number;
  /**
   * Login por chave de API: com a variável `env` no ambiente do agente, a
   * sessão pede ao agente o primeiro dos `methods` que ele anunciar.
   */
  readonly keyAuth?: { readonly env: string; readonly methods: readonly string[] };
}

const CLIENT_INFO = { name: 'fakl-code', title: 'FaKL-Code IDE', version: '0.1.0' };
const STOP_TIMEOUT_MS = 3_000;
const START_TIMEOUT_MS = 90_000;
const STDERR_TAIL_BYTES = 4_096;
/** Código JSON-RPC do ACP para "precisa de autenticação". */
const AUTH_REQUIRED = -32000;
/** Tipos de ferramenta que `aprovar-leitura` libera sem perguntar. */
const READ_ONLY_KINDS = new Set(['read', 'search', 'think']);
const resumePrompt = (): string => l10n.t('Continue where you left off.');
const EXIT_GRACE_MS = 500;
/** Falha de login passageira: outro Claude Code renovou o mesmo token ao mesmo tempo. */
const AUTH_RACE = /refresh(ing)? (the )?oauth token|oauth token refresh/i;
const AUTH_RETRY_MS = [3_000, 10_000];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Adaptador ACP (SDD 8.2): agente como processo filho, JSON-RPC por stdio. */
export class AcpAdapter implements AgentAdapter {
  readonly id = 'acp';

  constructor(
    readonly command: AcpCommand,
    private readonly hostEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async detect(): Promise<AdapterAvailability> {
    const found = await findExecutable(this.command.command, this.hostEnv);
    if (found) return { status: 'pronto', path: found };
    return {
      status: 'não-instalado',
      ...(this.command.install ? { install: this.command.install } : {}),
    };
  }

  async start(options: StartOptions): Promise<AgentHandle> {
    const session = new AcpSession(this.command, options, this.hostEnv);
    await session.open();
    return session;
  }
}

interface QueuedMessage {
  readonly text: string;
  /** Tentativas já feitas depois de uma falha passageira de login. */
  retries?: number;
  resolve(): void;
  reject(error: Error): void;
}

interface PendingPermission {
  readonly options: readonly acp.PermissionOption[];
  resolve(outcome: acp.RequestPermissionOutcome): void;
}

/**
 * A saída do agente como stream web. Quando o agente é encerrado, o stdio
 * (um socket) pode dar ECONNRESET; aqui isso só fecha o stream, em vez de virar
 * uma rejeição que ninguém trata dentro do SDK. O fim do processo é tratado
 * pelo evento `exit`.
 */
function quietReader(output: Readable): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Já cancelado por quem lia.
        }
      };
      output.on('data', (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          closed = true;
        }
      });
      output.once('end', close);
      output.once('close', close);
      output.on('error', close);
    },
    cancel() {
      closed = true;
    },
  });
}

/** A entrada do agente como stream web; escrever num agente que já saiu não é erro. */
function quietWriter(input: Writable): WritableStream<Uint8Array> {
  input.on('error', () => undefined);
  return new WritableStream<Uint8Array>({
    write(chunk) {
      if (input.destroyed || !input.writable) return undefined;
      return new Promise<void>((resolve) => {
        input.write(chunk, () => {
          resolve();
        });
      });
    },
    close() {
      input.end();
    },
    abort() {
      input.destroy();
    },
  });
}

/** Opções de sessão do ACP no formato do FaKL; grupos de valores viram uma lista só. */
export function optionsFromAcp(
  list: readonly acp.SessionConfigOption[] | null | undefined,
): AgentOptionInfo[] {
  return (list ?? []).map((option) => {
    const base = {
      id: option.id,
      nome: option.name,
      ...(option.category ? { categoria: option.category } : {}),
      ...(option.description ? { descricao: option.description } : {}),
    };
    if (option.type === 'boolean') return { ...base, atual: option.currentValue };
    const values = option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
    return {
      ...base,
      atual: option.currentValue,
      valores: values.map((value) => ({
        id: value.value,
        nome: value.name,
        ...(value.description ? { descricao: value.description } : {}),
      })),
    };
  });
}

/**
 * Método de login do ACP que usa a chave de API, quando a sessão recebeu a
 * chave e o agente anuncia um dos métodos esperados. Sem chave, vale o login
 * que o CLI já tem (assinatura).
 */
export function keyAuthMethod(
  command: AcpCommand,
  env: Readonly<Record<string, string>> | undefined,
  advertised: readonly { readonly id: string }[] | null | undefined,
): string | undefined {
  const auth = command.keyAuth;
  if (!auth || !env?.[auth.env]) return undefined;
  const ids = new Set((advertised ?? []).map((method) => method.id));
  return auth.methods.find((id) => ids.has(id));
}

const DETAIL_MAX_CHARS = 2_000;

/**
 * Argumentos de uma chamada de ferramenta (`rawInput` do ACP), um por linha,
 * para o pedido de permissão mostrar o que vai rodar: `comando: uptime`. Texto
 * vai como está; o resto, em JSON. Corta em 2.000 caracteres.
 */
export function describeToolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    text = Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(
        ([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
      )
      .join('\n');
  } else {
    text = JSON.stringify(input);
  }
  text = text.trim();
  if (text === '') return undefined;
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}…` : text;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class AcpSession implements AgentHandle {
  private current: AgentState = 'preparando';
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly queue: QueuedMessage[] = [];
  private readonly permissions = new Map<string, PendingPermission>();
  private child: ChildProcess | undefined;
  private connection: acp.ClientConnection | undefined;
  private sessionId: string | undefined;
  private running = false;
  /** A rodada em andamento foi cancelada por pause() e deve continuar no resume(). */
  private interrupted = false;
  private policy: PermissionPolicy;
  private configOptions: AgentOptionInfo[] = [];
  private firstPrompt = true;
  /** Durante `session/load` o agente reenvia a conversa antiga; isso não vira evento. */
  private replaying = false;
  private resumeKind: ResumeKind | undefined;
  private exited = false;
  private exitError: Error | undefined;
  private exitSeen: Promise<void> = Promise.resolve();
  private stderrTail = '';
  private totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private cacheRead = 0;
  private cost: Usage['cost'];
  private context: Usage['context'];
  /** Para estimar o uso de agentes que não o informam na resposta (codex-acp). */
  private turnContext = 0;
  private turnChars = 0;
  private readonly cwd: string;

  constructor(
    private readonly command: AcpCommand,
    private readonly options: StartOptions,
    private readonly hostEnv: NodeJS.ProcessEnv,
  ) {
    this.cwd = path.resolve(options.cwd);
    this.policy = options.permissions;
  }

  get state(): AgentState {
    return this.current;
  }

  get remoteSessionId(): string | undefined {
    return this.sessionId;
  }

  get resumedAs(): ResumeKind | undefined {
    return this.resumeKind;
  }

  async open(): Promise<void> {
    const child = spawn(this.command.command, [...this.command.args], {
      cwd: this.cwd,
      env: agentEnv(this.hostEnv, { ...this.command.env, ...this.options.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Grupo de processos próprio, para stop() encerrar também os filhos do agente.
      detached: process.platform !== 'win32',
    });
    this.child = child;

    const exited = new Promise<never>((_, reject) => {
      child.once('error', (error) => {
        reject(this.spawnError(error));
      });
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            l10n.t(
              'the agent exited ({0}). {1}',
              signal ?? l10n.t('code {0}', String(code)),
              this.stderrTail,
            ),
          ),
        );
      });
    });
    exited.catch(() => undefined);
    this.exitSeen = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.onExit(code, signal);
        resolve();
      });
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    if (!child.stdin || !child.stdout) throw new Error(l10n.t('agent without stdio'));
    const stream = acp.ndJsonStream(quietWriter(child.stdin), quietReader(child.stdout));
    this.connection = acp
      .client({ name: CLIENT_INFO.name })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        this.onUpdate(params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        this.onPermission(params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => this.readFile(params))
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => this.writeFile(params))
      .connect(stream);
    const agent = this.connection.agent;

    // Um agente que abre mas nunca responde (login pendente, rede) não pode prender a execução.
    const startMs = this.command.startTimeoutMs ?? START_TIMEOUT_MS;
    let startTimer: NodeJS.Timeout | undefined;
    const startTimeout = { fired: false };
    const timedOut = new Promise<never>((_, reject) => {
      startTimer = setTimeout(() => {
        startTimeout.fired = true;
        const login = this.command.login
          ? l10n.t('; check the login ({0})', this.command.login)
          : '';
        reject(
          new Error(
            l10n
              .t(
                '{0} did not respond within {1} s on startup{2}. {3}',
                this.command.command,
                String(Math.round(startMs / 1000)),
                login,
                this.stderrTail,
              )
              .trim(),
          ),
        );
      }, startMs);
    });
    timedOut.catch(() => undefined);
    try {
      const init = (await Promise.race([
        agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: CLIENT_INFO,
        }),
        exited,
        timedOut,
      ])) as acp.InitializeResponse;
      const method = keyAuthMethod(this.command, this.options.env, init.authMethods);
      if (method) {
        await Promise.race([
          agent.request(acp.methods.agent.authenticate, { methodId: method }),
          exited,
          timedOut,
        ]);
      }
      const http = init.agentCapabilities?.mcpCapabilities?.http === true;
      const mcpServers: acp.McpServer[] = [];
      for (const server of prepareMcpServers(this.options.mcpServers ?? [], this.cwd)) {
        if (server.type === 'http') {
          // Agente sem suporte a MCP remoto: o servidor fica de fora em vez de quebrar a sessão.
          if (!http) continue;
          mcpServers.push({
            type: 'http',
            name: server.name,
            url: server.url,
            headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
          });
        } else {
          mcpServers.push({
            name: server.name,
            command: server.command,
            args: [...server.args],
            env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
          });
        }
      }
      const meta = this.options.sessionMeta ? { _meta: { ...this.options.sessionMeta } } : {};
      const resumeId = this.options.resume?.sessionId;
      let reopened = false;
      if (resumeId) {
        // Retoma a sessão do próprio agente quando ele sabe (load ou resume); senão cai no histórico.
        const caps = init.agentCapabilities;
        const method = caps?.loadSession
          ? acp.methods.agent.session.load
          : caps?.sessionCapabilities?.resume
            ? acp.methods.agent.session.resume
            : undefined;
        if (method) {
          this.replaying = true;
          try {
            const response = (await Promise.race([
              agent.request(method, { sessionId: resumeId, cwd: this.cwd, mcpServers, ...meta }),
              exited,
              timedOut,
            ])) as { configOptions?: acp.SessionConfigOption[] | null } | null | undefined;
            this.sessionId = resumeId;
            this.configOptions = optionsFromAcp(response?.configOptions);
            this.firstPrompt = false;
            this.resumeKind = 'sessão';
            reopened = true;
          } catch (error) {
            // O agente não guarda mais essa sessão: segue como sessão nova, com o histórico.
            if (!(error instanceof acp.RequestError)) throw error;
          } finally {
            this.replaying = false;
          }
        }
      }
      if (!reopened) {
        const request: acp.NewSessionRequest = { cwd: this.cwd, mcpServers, ...meta };
        const created = await Promise.race([
          agent.request(acp.methods.agent.session.new, request),
          exited,
          timedOut,
        ]);
        this.sessionId = created.sessionId;
        this.configOptions = optionsFromAcp(created.configOptions);
        if (this.options.resume) this.resumeKind = 'histórico';
      }
    } catch (error) {
      // "ACP connection closed" não diz nada: se o processo caiu ou nem abriu, o motivo vem dele.
      let reason: Error | undefined;
      if (!(error instanceof acp.RequestError) && !startTimeout.fired) {
        reason = await Promise.race([
          exited.then(
            () => undefined,
            (cause: unknown) => cause as Error,
          ),
          delay(EXIT_GRACE_MS * 2).then(() => undefined),
        ]);
      }
      await this.kill();
      throw reason ?? this.describe(error);
    } finally {
      clearTimeout(startTimer);
    }
    this.transition(['preparando'], 'ocioso');
  }

  send(message: string): Promise<void> {
    if (isFinalAgentState(this.current)) {
      return Promise.reject(new Error(l10n.t('agent {0}', this.current)));
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text: message, resolve, reject });
      this.pump();
    });
  }

  onEvent(listener: (event: AgentEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  respondPermission(id: string, allow: boolean, always = false): Promise<void> {
    const pending = this.permissions.get(id);
    if (!pending) return Promise.reject(new Error(l10n.t('no permission request {0} is open', id)));
    this.permissions.delete(id);
    // "Sempre" só vale se o agente oferece a opção; senão, cai na permissão avulsa.
    const wanted = allow
      ? always
        ? ['allow_always', 'allow_once']
        : ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always'];
    const option = wanted
      .map((kind) => pending.options.find((o) => o.kind === kind))
      .find((o) => o !== undefined);
    pending.resolve(
      option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' },
    );
    this.transition(['aguardando-permissão'], allow ? 'executando' : 'pensando');
    return Promise.resolve();
  }

  setPermissions(policy: PermissionPolicy): void {
    this.policy = policy;
  }

  sessionOptions(): readonly AgentOptionInfo[] {
    return this.configOptions;
  }

  async setOption(id: string, value: string | boolean): Promise<void> {
    const option = this.configOptions.find((o) => o.id === id);
    if (!option) throw new Error(l10n.t('the agent has no option {0}', id));
    if (typeof value !== typeof option.atual) throw new Error(l10n.t('invalid value for {0}', id));
    if (option.valores && !option.valores.some((v) => v.id === value)) {
      throw new Error(l10n.t('{0} is not a value of {1}', String(value), option.nome));
    }
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (!connection || !sessionId) throw new Error(l10n.t('agent is not ready yet'));
    const response = await connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      typeof value === 'boolean'
        ? { sessionId, configId: id, type: 'boolean', value }
        : { sessionId, configId: id, value },
    );
    this.configOptions = optionsFromAcp(response.configOptions);
    this.emit({ type: 'options', options: this.configOptions });
  }

  async pause(): Promise<void> {
    if (isFinalAgentState(this.current)) throw new Error(l10n.t('agent {0}', this.current));
    if (this.current === 'pausado') return;
    const wasBusy = this.running;
    this.setState('pausado');
    if (wasBusy) {
      this.interrupted = true;
      this.cancelPermissions();
      await this.cancelTurn();
    }
  }

  resume(continuar = true): Promise<void> {
    if (this.current !== 'pausado') return Promise.resolve();
    this.setState('ocioso');
    if (this.interrupted) {
      this.interrupted = false;
      if (continuar)
        this.queue.unshift({
          text: resumePrompt(),
          resolve: () => undefined,
          reject: () => undefined,
        });
    }
    this.pump();
    return Promise.resolve();
  }

  async stop(reason: StopReason): Promise<void> {
    if (isFinalAgentState(this.current)) return;
    this.setState('parado', reason);
    this.cancelPermissions();
    this.rejectQueue(new Error(l10n.t('agent stopped')));
    await this.cancelTurn();
    await this.kill();
  }

  usage(): Usage {
    return {
      ...this.totals,
      ...(this.cacheRead > 0 ? { cacheReadTokens: this.cacheRead } : {}),
      ...(this.cost ? { cost: this.cost } : {}),
      ...(this.context ? { context: this.context } : {}),
    };
  }

  private pump(): void {
    if (this.running || this.current !== 'ocioso' || !this.connection || !this.sessionId) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    this.setState('pensando');

    const prompt: acp.ContentBlock[] = [];
    const wasFirst = this.firstPrompt;
    if (this.firstPrompt && this.options.systemPrompt) {
      prompt.push({ type: 'text', text: this.options.systemPrompt });
    }
    if (this.firstPrompt && this.resumeKind === 'histórico' && this.options.resume?.history) {
      prompt.push({ type: 'text', text: this.options.resume.history });
    }
    this.firstPrompt = false;
    prompt.push({ type: 'text', text: next.text });
    this.turnContext = 0;
    this.turnChars = 0;

    this.connection.agent
      .request(acp.methods.agent.session.prompt, { sessionId: this.sessionId, prompt })
      .then(
        (response) => {
          this.addUsage(response.usage ?? this.estimatedUsage());
          this.running = false;
          this.transition(['pensando', 'executando', 'aguardando-permissão'], 'ocioso');
          next.resolve();
          this.pump();
        },
        async (error: unknown) => {
          // Se o processo caiu, a conexão fecha antes do evento de saída chegar;
          // espera um pouco para relatar a saída, que explica mais.
          if (!this.exited) await Promise.race([this.exitSeen, delay(EXIT_GRACE_MS)]);
          this.running = false;
          const described = this.exitError ?? this.describe(error);
          const retries = next.retries ?? 0;
          if (
            this.exitError === undefined &&
            !isFinalAgentState(this.current) &&
            AUTH_RACE.test(described.message) &&
            retries < AUTH_RETRY_MS.length
          ) {
            // Outro Claude Code renovando o mesmo login ao mesmo tempo: espera e repete a vez.
            const wait = AUTH_RETRY_MS[retries] ?? 0;
            this.emit({
              type: 'output',
              kind: 'thought',
              text: `\n(${l10n.t('The login is being renewed by another process; retrying in {0} s.', String(wait / 1000))})\n`,
            });
            next.retries = retries + 1;
            await delay(wait);
            if (isFinalAgentState(this.current)) {
              next.reject(described);
              return;
            }
            if (wasFirst) this.firstPrompt = true;
            this.queue.unshift(next);
            this.transition(['pensando', 'executando', 'aguardando-permissão'], 'ocioso');
            this.pump();
            return;
          }
          if (this.exitError !== undefined || !isFinalAgentState(this.current))
            this.emit({ type: 'error', message: described.message });
          this.transition(['pensando', 'executando', 'aguardando-permissão'], 'ocioso');
          next.reject(described);
          this.pump();
        },
      );
  }

  private onUpdate(update: acp.SessionUpdate): void {
    if (this.replaying) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          this.turnChars += update.content.text.length;
          this.emit({
            type: 'output',
            kind: update.sessionUpdate === 'agent_message_chunk' ? 'message' : 'thought',
            text: update.content.text,
          });
        }
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const status = update.status ?? undefined;
        const input = toolInputKey(update.rawInput);
        this.emit({
          type: 'tool',
          toolCallId: update.toolCallId,
          ...(update.title ? { title: update.title } : {}),
          ...(input ? { input } : {}),
          ...(update.kind ? { kind: update.kind } : {}),
          ...(status ? { status } : {}),
        });
        if (status === 'completed' || status === 'failed') {
          this.transition(['executando'], 'pensando');
        } else if (update.sessionUpdate === 'tool_call' || status === 'in_progress') {
          this.transition(['pensando'], 'executando');
        }
        break;
      }
      case 'config_option_update':
        this.configOptions = optionsFromAcp(update.configOptions);
        this.emit({ type: 'options', options: this.configOptions });
        break;
      case 'usage_update': {
        this.turnContext = update.used;
        const context = update.size > 0 ? { used: update.used, size: update.size } : this.context;
        const changed =
          context?.used !== this.context?.used || context?.size !== this.context?.size;
        this.context = context;
        if (update.cost) {
          this.cost = { amount: update.cost.amount, currency: update.cost.currency };
        }
        if (update.cost || changed) this.emit({ type: 'usage', usage: this.usage() });
        break;
      }
      default:
        break;
    }
  }

  private onPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const policy = this.policy;
    const kind = params.toolCall.kind ?? undefined;
    const autoAllow =
      policy === 'aprovar-tudo' ||
      (policy === 'aprovar-leitura' && kind !== undefined && READ_ONLY_KINDS.has(kind));
    if (autoAllow) {
      const option = params.options.find(
        (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
      );
      return Promise.resolve({
        outcome: option
          ? { outcome: 'selected', optionId: option.optionId }
          : { outcome: 'cancelled' },
      });
    }
    if (this.current === 'pausado' || isFinalAgentState(this.current)) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }

    const id = params.toolCall.toolCallId;
    const detail = describeToolInput(params.toolCall.rawInput);
    return new Promise((resolve) => {
      this.permissions.set(id, {
        options: params.options,
        resolve: (outcome) => {
          resolve({ outcome });
        },
      });
      this.transition(['pensando', 'executando'], 'aguardando-permissão');
      this.emit({
        type: 'permission',
        id,
        title: params.toolCall.title ?? l10n.t('Permission requested by the agent'),
        ...(detail ? { detail } : {}),
        options: params.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
      });
    });
  }

  /**
   * Leitura e escrita pelo cliente ficam presas ao worktree. É uma proteção
   * contra engano do agente, não um sandbox: as ferramentas próprias dele rodam
   * com as permissões do usuário.
   */
  private resolveInside(file: string): string {
    const target = path.resolve(this.cwd, file);
    if (!isInside(this.cwd, target)) {
      throw acp.RequestError.invalidParams(
        { path: file },
        l10n.t('path outside the agent worktree'),
      );
    }
    return target;
  }

  private async readFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await readFile(this.resolveInside(params.path), 'utf8');
    if (params.line == null && params.limit == null) return { content };
    const lines = content.split('\n');
    const start = Math.max((params.line ?? 1) - 1, 0);
    const end = params.limit == null ? undefined : start + params.limit;
    return { content: lines.slice(start, end).join('\n') };
  }

  private async writeFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const target = this.resolveInside(params.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, params.content, 'utf8');
    this.emit({ type: 'file', path: path.relative(this.cwd, target) });
    return {};
  }

  /**
   * Uso aproximado de uma rodada sem `usage` na resposta: o contexto da última
   * chamada como entrada e ~4 caracteres por token no texto que o agente
   * escreveu. Subestima rodadas com várias chamadas, mas não deixa o teto
   * diário e o placar em zero.
   */
  private estimatedUsage(): acp.Usage | undefined {
    if (this.turnContext === 0 && this.turnChars === 0) return undefined;
    const outputTokens = Math.ceil(this.turnChars / 4);
    return {
      inputTokens: this.turnContext,
      outputTokens,
      totalTokens: this.turnContext + outputTokens,
    };
  }

  /**
   * O ACP separa a entrada nova do que foi lido e escrito no cache; o
   * claude-agent-acp informa 12 tokens de entrada numa rodada que enviou 230
   * mil. A entrada aqui é tudo o que foi enviado, e a leitura do cache fica à
   * parte para quem quiser mostrar o desconto.
   */
  private addUsage(usage: acp.Usage | null | undefined): void {
    if (!usage) return;
    const read = usage.cachedReadTokens ?? 0;
    const input = usage.inputTokens + read + (usage.cachedWriteTokens ?? 0);
    this.cacheRead += read;
    this.totals = {
      inputTokens: this.totals.inputTokens + input,
      outputTokens: this.totals.outputTokens + usage.outputTokens,
      totalTokens: this.totals.totalTokens + usage.totalTokens,
    };
    this.emit({ type: 'usage', usage: this.usage() });
  }

  private async cancelTurn(): Promise<void> {
    if (!this.running || !this.connection || !this.sessionId || this.exited) return;
    await this.connection.agent
      .notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId })
      .catch(() => undefined);
  }

  private cancelPermissions(): void {
    for (const pending of this.permissions.values()) pending.resolve({ outcome: 'cancelled' });
    this.permissions.clear();
  }

  private rejectQueue(error: Error): void {
    for (const item of this.queue.splice(0)) item.reject(error);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.connection?.close();
    this.cancelPermissions();
    if (isFinalAgentState(this.current) || this.current === 'preparando') return;
    this.exitError = new Error(
      l10n
        .t(
          'the agent exited on its own ({0}). {1}',
          signal ?? l10n.t('code {0}', String(code)),
          this.stderrTail,
        )
        .trim(),
    );
    this.setState('falhou');
    this.rejectQueue(this.exitError);
    // Sem rodada em andamento ninguém mais relata a falha; com rodada, o erro sai pelo send().
    if (!this.running) this.emit({ type: 'error', message: this.exitError.message });
  }

  /** Encerra o agente e os processos dele; força depois de alguns segundos. */
  private async kill(): Promise<void> {
    const child = this.child;
    this.connection?.close();
    if (!child || this.exited || child.pid === undefined) return;
    // Já saiu (o cross-spawn pode ter trocado o `exit` por `error`): não há o que esperar.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    // Com o cross-spawn no Windows, "comando não encontrado" chega como `error` e o
    // `exit` nunca vem; esperar só por ele travava a criação do agente para sempre.
    const gone = new Promise<void>((resolve) => {
      for (const name of ['exit', 'close', 'error'] as const) {
        child.once(name, () => {
          resolve();
        });
      }
    });
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (process.platform === 'win32') {
          // Pelo cmd.exe do npm, o node do agente é neto: /T leva a árvore toda.
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          process.kill(-pid, name);
        }
      } catch {
        child.kill(name);
      }
    };
    child.stdin?.end();
    signal('SIGTERM');
    const timer = setTimeout(() => {
      signal('SIGKILL');
    }, STOP_TIMEOUT_MS);
    await gone;
    clearTimeout(timer);
  }

  /** Falha ao abrir o processo; o mais comum é o agente não estar instalado. */
  private spawnError(error: NodeJS.ErrnoException): Error {
    const name = this.command.command;
    if (error.code === 'ENOENT') {
      const install = this.command.install
        ? ` ${l10n.t('Install with: {0}', this.command.install)}`
        : '';
      return new Error(
        l10n.t(
          'the agent "{0}" was not found in the IDE PATH.{1} (if you just installed it, restart the IDE so it sees the new PATH)',
          name,
          install,
        ),
      );
    }
    return new Error(l10n.t('could not start {0}: {1}', name, error.message));
  }

  private describe(error: unknown): Error {
    if (error instanceof acp.RequestError && error.code === AUTH_REQUIRED) {
      const hint = this.command.login ? `: ${this.command.login}` : '';
      return new Error(l10n.t('the agent needs a login{0}', hint));
    }
    if (error instanceof acp.RequestError && error.data !== undefined && error.data !== null) {
      // "Internal error" sozinho não explica nada; o motivo real vem em `data`.
      const data = error.data as { details?: unknown };
      const details = typeof data.details === 'string' ? data.details : JSON.stringify(error.data);
      if (details && details !== '{}')
        return new Error(`${error.message}: ${details}`, { cause: error });
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** Muda de estado só se o atual estiver em `from`; pausa e estados finais não são desfeitos por eventos atrasados. */
  private transition(from: readonly AgentState[], to: AgentState): void {
    if (from.includes(this.current)) this.setState(to);
  }

  private setState(state: AgentState, reason?: StopReason): void {
    if (state === this.current) return;
    const previous = this.current;
    this.current = state;
    this.emit({ type: 'state', state, previous, ...(reason ? { reason } : {}) });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
