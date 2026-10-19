import { l10n } from '@fakl/i18n';
import {
  isFinalAgentState,
  type AdapterAvailability,
  type AgentOptionInfo,
  type AgentState,
  type TerminalReportedState,
} from '@fakl/protocol';

import { findExecutable } from '../which.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  AgentProfile,
  Disposable,
  PermissionPolicy,
  StartOptions,
  StopReason,
  Usage,
} from '../types.js';
import { terminalCommandForProfile } from './command.js';
import { sanitizeTerminalInput, terminalInputRefusal } from './policy.js';

/** Pedido de criação de um terminal; todos os campos vêm do perfil (nada vem do agente). */
export interface TerminalSpawnRequest {
  readonly sessionId: string;
  readonly nome: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly prompt?: string;
  readonly silencioSegundos?: number;
}

/** O que o terminal hospedado informa ao Core. */
export type TerminalReport =
  | { readonly type: 'ready' }
  | { readonly type: 'output'; readonly text: string }
  | { readonly type: 'state'; readonly state: TerminalReportedState }
  | {
      readonly type: 'exit';
      readonly code?: number | undefined;
      readonly error?: string | undefined;
    };

/** Canal de uma sessão com o terminal que a extensão mantém. */
export interface TerminalChannel {
  /** Digita uma linha no terminal (a extensão acrescenta o Enter). */
  write(text: string): void;
  /** Fecha o terminal. */
  stop(): void;
  onReport(listener: (report: TerminalReport) => void): Disposable;
}

/** Ponte com a extensão que hospeda os terminais (no Core, `TerminalHost`). */
export interface TerminalHostLink {
  /** Há uma IDE conectada que sabe criar terminais? */
  available(): boolean;
  spawn(request: TerminalSpawnRequest): TerminalChannel;
}

export interface TerminalAdapterOptions {
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Quanto esperar a extensão confirmar que o terminal abriu. */
  readonly spawnTimeoutMs?: number;
}

const SPAWN_TIMEOUT_MS = 20_000;

/**
 * Adaptador de CLI interativa (RF-103, ADR 0047). O processo roda num terminal
 * do VS Code que a extensão `fakl-core` hospeda; este adaptador só conversa
 * com ela pela ponte, então roda no Core sem módulo nativo nem PTY próprio.
 */
export class TerminalAdapter implements AgentAdapter {
  readonly id = 'terminal';

  constructor(
    private readonly profile: AgentProfile,
    private readonly link: TerminalHostLink | undefined,
    private readonly options: TerminalAdapterOptions = {},
  ) {}

  async detect(): Promise<AdapterAvailability> {
    const command = this.profile.comando?.trim();
    if (!command) return { status: 'não-instalado' };
    const found = await findExecutable(command, this.options.hostEnv ?? process.env);
    return found ? { status: 'pronto', path: found } : { status: 'não-instalado' };
  }

  start(options: StartOptions): Promise<AgentHandle> {
    const sessionId = options.env?.FAKL_AGENT_SESSION;
    if (!sessionId) {
      return Promise.reject(
        new Error('terminal agent needs FAKL_AGENT_SESSION in the environment'),
      );
    }
    if (!this.link?.available()) {
      return Promise.reject(
        new Error(
          l10n.t(
            'a terminal agent runs in an IDE terminal, but no IDE window is connected to the Core',
          ),
        ),
      );
    }
    const command = terminalCommandForProfile(this.profile);
    const channel = this.link.spawn({
      sessionId,
      nome: this.profile.nome,
      command: command.command,
      args: command.args,
      cwd: options.cwd,
      env: command.env,
      ...(this.profile.terminal?.prompt ? { prompt: this.profile.terminal.prompt } : {}),
      ...(this.profile.terminal?.silencioSegundos
        ? { silencioSegundos: this.profile.terminal.silencioSegundos }
        : {}),
    });
    return Promise.resolve(
      new TerminalSession(channel, options.permissions, this.options.spawnTimeoutMs),
    );
  }
}

interface QueuedMessage {
  readonly text: string;
  resolve(): void;
  reject(error: Error): void;
}

/**
 * Sessão de um agente de terminal. `preparando` até a primeira vez que a CLI
 * fica ociosa; `executando` enquanto sai texto; `ocioso` quando a heurística
 * diz que ela espera. Custo e contexto não existem: `usage()` é sempre zero.
 */
export class TerminalSession implements AgentHandle {
  private current: AgentState = 'preparando';
  private policy: PermissionPolicy;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly queue: QueuedMessage[] = [];
  private readonly subscription: Disposable;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  /** A CLI está esperando uma mensagem (última decisão da heurística). */
  private idle = false;
  private paused = false;
  /** Mensagem já digitada cuja rodada ainda não terminou. */
  private inFlight: QueuedMessage | undefined;

  constructor(
    private readonly channel: TerminalChannel,
    policy: PermissionPolicy,
    spawnTimeoutMs = SPAWN_TIMEOUT_MS,
  ) {
    this.policy = policy;
    this.subscription = channel.onReport((report) => {
      this.onReport(report);
    });
    this.readyTimer = setTimeout(() => {
      this.fail(l10n.t('the IDE did not open the agent terminal in time'));
    }, spawnTimeoutMs);
  }

  get state(): AgentState {
    return this.current;
  }

  send(message: string): Promise<void> {
    if (isFinalAgentState(this.current)) {
      return Promise.reject(new Error(l10n.t('agent {0}', this.current)));
    }
    const refusal = terminalInputRefusal(this.policy);
    if (refusal) {
      this.emit({ type: 'error', message: refusal });
      return Promise.reject(new Error(refusal));
    }
    const text = sanitizeTerminalInput(message);
    if (text === '') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
      this.pump();
    });
  }

  onEvent(listener: (event: AgentEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  respondPermission(id: string): Promise<void> {
    // Não há pedido estruturado: a CLI pergunta no terminal e quem responde é o usuário.
    return Promise.reject(new Error(l10n.t('no permission request {0} is open', id)));
  }

  setPermissions(policy: PermissionPolicy): void {
    this.policy = policy;
    if (!canSend(policy)) this.rejectQueued();
  }

  sessionOptions(): readonly AgentOptionInfo[] {
    return [];
  }

  setOption(id: string, value: string | boolean): Promise<void> {
    return Promise.reject(new Error(l10n.t('invalid option: {0}={1}', id, String(value))));
  }

  pause(): Promise<void> {
    if (isFinalAgentState(this.current)) {
      return Promise.reject(new Error(l10n.t('agent {0}', this.current)));
    }
    // Pausar só segura as mensagens do Core; a CLI no terminal não é interrompida.
    this.paused = true;
    this.setState('pausado');
    return Promise.resolve();
  }

  resume(): Promise<void> {
    if (this.current !== 'pausado') return Promise.resolve();
    this.paused = false;
    this.setState(this.idle ? 'ocioso' : this.awaitingReady() ? 'preparando' : 'executando');
    this.pump();
    return Promise.resolve();
  }

  stop(reason: StopReason): Promise<void> {
    if (isFinalAgentState(this.current)) return Promise.resolve();
    this.finish('parado', reason);
    this.channel.stop();
    return Promise.resolve();
  }

  usage(): Usage {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  private awaitingReady(): boolean {
    return this.readyTimer !== undefined;
  }

  private onReport(report: TerminalReport): void {
    if (isFinalAgentState(this.current)) return;
    switch (report.type) {
      case 'ready':
        // O terminal abriu; a CLI ainda sobe, então segue em `preparando` até o primeiro "ocioso".
        return;
      case 'output':
        if (report.text !== '') {
          this.emit({ type: 'output', kind: 'message', text: `${report.text}\n` });
        }
        return;
      case 'state':
        this.onState(report.state);
        return;
      case 'exit':
        if (report.error || (report.code !== undefined && report.code !== 0)) {
          this.fail(
            report.error ??
              l10n.t('the agent command exited with code {0}', String(report.code ?? '')),
          );
        } else {
          this.finish('concluído');
        }
    }
  }

  private onState(state: TerminalReportedState): void {
    this.clearReadyTimer();
    this.idle = state === 'ocioso';
    if (this.paused) return;
    if (state === 'ocioso') {
      this.setState('ocioso');
      // A rodada da mensagem em andamento termina quando a CLI volta a esperar.
      const done = this.inFlight;
      this.inFlight = undefined;
      done?.resolve();
      this.pump();
    } else {
      this.setState('executando');
    }
  }

  private pump(): void {
    if (this.paused || !this.idle || this.inFlight || isFinalAgentState(this.current)) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    // A CLI vai escrever o eco e a resposta; até lá o terminal já conta como ocupado.
    this.idle = false;
    this.setState('executando');
    this.channel.write(next.text);
  }

  private rejectQueued(): void {
    const error = new Error(terminalInputRefusal('perguntar') ?? '');
    for (const queued of this.queue.splice(0)) queued.reject(error);
  }

  private fail(message: string): void {
    this.emit({ type: 'error', message });
    this.finish('falhou');
    this.channel.stop();
  }

  private finish(state: 'parado' | 'concluído' | 'falhou', reason?: StopReason): void {
    this.clearReadyTimer();
    const error = new Error(l10n.t('agent {0}', state));
    this.inFlight?.reject(error);
    this.inFlight = undefined;
    for (const queued of this.queue.splice(0)) queued.reject(error);
    this.setState(state, reason);
    this.subscription.dispose();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private setState(next: AgentState, reason?: StopReason): void {
    if (this.current === next) return;
    const previous = this.current;
    this.current = next;
    this.emit({
      type: 'state',
      state: next,
      previous,
      ...(reason ? { reason } : {}),
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function canSend(policy: PermissionPolicy): boolean {
  return terminalInputRefusal(policy) === undefined;
}
