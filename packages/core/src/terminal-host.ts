import type {
  Disposable,
  TerminalChannel,
  TerminalHostLink,
  TerminalReport,
  TerminalSpawnRequest,
} from '@fakl/agents';
import { l10n } from '@fakl/i18n';
import {
  CoreNotifications,
  FaklErrorCode,
  type TerminalHostCommand,
  type TerminalHostRegisterParams,
} from '@fakl/protocol';

import {
  objectParams,
  RpcError,
  stringParam,
  type CallContext,
  type Router,
} from './rpc/router.js';

/** Quanto texto de saída um único relatório pode trazer; o resto é cortado. */
export const TERMINAL_REPORT_MAX_CHARS = 64_000;
/** Tempo que uma IDE desconectada tem para voltar antes de os terminais dela serem dados como perdidos. */
const HOST_GRACE_MS = 30_000;

class HostChannel implements TerminalChannel {
  private readonly listeners = new Set<(report: TerminalReport) => void>();

  constructor(
    readonly sessionId: string,
    private readonly host: TerminalHost,
  ) {}

  write(text: string): void {
    this.host.command({ type: 'input', sessionId: this.sessionId, text });
  }

  stop(): void {
    this.host.command({ type: 'stop', sessionId: this.sessionId });
    this.host.release(this.sessionId);
  }

  onReport(listener: (report: TerminalReport) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  deliver(report: TerminalReport): void {
    for (const listener of [...this.listeners]) listener(report);
  }
}

/**
 * Ponte entre os agentes de terminal e a extensão da IDE (ADR 0047). O PTY é o
 * terminal integrado do VS Code, que só existe no processo da extensão; o Core
 * pede a ela, por notificação, que crie o terminal, digite uma linha ou o feche,
 * e recebe de volta, por chamadas `agents.terminalHost.*`, a saída já em linhas e
 * a decisão ocioso/executando. Só uma IDE hospeda por vez (a última que se registra).
 */
export class TerminalHost implements TerminalHostLink {
  private host: CallContext | undefined;
  private readonly channels = new Map<string, HostChannel>();
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly graceMs: number = HOST_GRACE_MS) {}

  register(router: Router): void {
    router.register('agents.terminalHost.register', (params, context) => {
      this.attach(params, context);
      return null;
    });
    router.register('agents.terminalHost.ready', (params, context) => {
      this.report(params, context, () => ({ type: 'ready' }));
      return null;
    });
    router.register('agents.terminalHost.output', (params, context) => {
      this.report(params, context, (p) => ({
        type: 'output',
        text: typeof p.text === 'string' ? p.text.slice(0, TERMINAL_REPORT_MAX_CHARS) : '',
      }));
      return null;
    });
    router.register('agents.terminalHost.state', (params, context) => {
      this.report(params, context, (p) => {
        if (p.state !== 'ocioso' && p.state !== 'executando') {
          throw RpcError.invalidParams(l10n.t('state must be {0}', 'ocioso, executando'));
        }
        return { type: 'state', state: p.state };
      });
      return null;
    });
    router.register('agents.terminalHost.exit', (params, context) => {
      const id = this.report(params, context, (p) => ({
        type: 'exit',
        code: typeof p.code === 'number' ? p.code : undefined,
        error: typeof p.error === 'string' && p.error ? p.error : undefined,
      }));
      this.channels.delete(id);
      return null;
    });
  }

  available(): boolean {
    return this.host !== undefined;
  }

  spawn(request: TerminalSpawnRequest): TerminalChannel {
    const host = this.host;
    if (!host) throw new Error(l10n.t('no IDE window is connected to the Core'));
    const channel = new HostChannel(request.sessionId, this);
    this.channels.set(request.sessionId, channel);
    this.command({ type: 'spawn', ...request });
    return channel;
  }

  /** Sessões de terminal abertas (testes e diagnóstico). */
  sessions(): string[] {
    return [...this.channels.keys()];
  }

  /** @internal Usado pelos canais. */
  command(command: TerminalHostCommand): void {
    try {
      this.host?.notify(CoreNotifications.terminalHost, command);
    } catch {
      // A conexão caiu no meio; o aviso de perda cuida da sessão.
    }
  }

  /** @internal O canal acabou: some do mapa. */
  release(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  dispose(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.host = undefined;
    this.channels.clear();
  }

  private attach(params: unknown, context: CallContext): void {
    if (context.principal !== undefined) {
      throw new RpcError(FaklErrorCode.Forbidden, l10n.t('only the IDE can host agent terminals'));
    }
    const p = objectParams(params ?? {}) as Partial<TerminalHostRegisterParams>;
    const kept = new Set(
      Array.isArray(p.sessions) ? p.sessions.filter((id) => typeof id === 'string') : [],
    );
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.host = context;
    context.onClose(() => {
      if (this.host !== context) return;
      this.host = undefined;
      // A IDE pode só ter reconectado: os terminais dela esperam um pouco.
      this.graceTimer = setTimeout(() => {
        this.lose(new Set());
      }, this.graceMs);
      this.graceTimer.unref();
    });
    // Quem se registra de novo diz quais terminais ainda tem; os outros foram perdidos.
    this.lose(kept);
  }

  private lose(kept: ReadonlySet<string>): void {
    for (const [id, channel] of [...this.channels]) {
      if (kept.has(id)) continue;
      this.channels.delete(id);
      channel.deliver({
        type: 'exit',
        error: l10n.t('the IDE window that hosted the terminal went away'),
      });
    }
  }

  private report(
    params: unknown,
    context: CallContext,
    build: (p: Record<string, unknown>) => TerminalReport,
  ): string {
    const p = objectParams(params);
    if (context !== this.host) {
      throw RpcError.invalidParams(l10n.t('this connection is not hosting agent terminals'));
    }
    const sessionId = stringParam(p, 'sessionId');
    const channel = this.channels.get(sessionId);
    if (!channel) throw RpcError.notFound(l10n.t('session {0} does not exist', sessionId));
    channel.deliver(build(p));
    return sessionId;
  }
}
