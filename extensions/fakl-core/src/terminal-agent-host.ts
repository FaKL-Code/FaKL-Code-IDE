import { TerminalStream, sanitizeTerminalInput } from '@fakl/agents';
import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type {
  TerminalHostCommand,
  TerminalHostRegisterParams,
  TerminalHostReportParams,
} from '@fakl/protocol';

/**
 * Hospedeiro dos agentes de terminal (ADR 0047). O PTY é o terminal integrado do
 * VS Code: a extensão cria o terminal, roda a CLI do perfil pela integração de
 * shell (`executeCommand` + `read()`), transforma o fluxo em linhas e em
 * "ocioso/executando" e conta tudo ao Core. As teclas que o Core manda
 * (`send_message` do maestro) viram `sendText`. Este módulo só enxerga o
 * `vscode.window` pela interface abaixo, para os testes injetarem um terminal falso.
 */

export interface HostExecution {
  read(): AsyncIterable<string>;
}

export interface HostShellIntegration {
  executeCommand(executable: string, args: string[]): HostExecution;
}

export interface HostTerminal {
  readonly name: string;
  readonly shellIntegration: HostShellIntegration | undefined;
  readonly exitStatus: { readonly code: number | undefined } | undefined;
  sendText(text: string, shouldExecute?: boolean): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface HostDisposable {
  dispose(): unknown;
}

/** O pedaço de `vscode.window` de que o hospedeiro precisa. */
export interface TerminalWindowApi {
  createTerminal(options: { name: string; cwd: string; env: Record<string, string> }): HostTerminal;
  onDidChangeTerminalShellIntegration(
    listener: (event: { terminal: HostTerminal; shellIntegration: HostShellIntegration }) => void,
  ): HostDisposable;
  onDidEndTerminalShellExecution(
    listener: (event: {
      terminal: HostTerminal;
      execution: HostExecution;
      exitCode: number | undefined;
    }) => void,
  ): HostDisposable;
  onDidCloseTerminal(listener: (terminal: HostTerminal) => void): HostDisposable;
}

export interface TerminalAgentHostOptions {
  readonly now?: () => number;
  /** Passo da heurística de ocioso. */
  readonly tickMs?: number;
  /** Quanto esperar a integração de shell antes de desistir. */
  readonly integrationTimeoutMs?: number;
  /** Junta saída por este tempo antes de mandar ao Core. */
  readonly flushMs?: number;
}

interface Hosted {
  readonly sessionId: string;
  readonly terminal: HostTerminal;
  readonly stream: TerminalStream;
  lines: string[];
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  integrationTimer: ReturnType<typeof setTimeout> | undefined;
  execution: HostExecution | undefined;
  exited: boolean;
  readonly request: Extract<TerminalHostCommand, { type: 'spawn' }>;
}

type HostClient = Pick<CoreClient, 'request'>;

export class TerminalAgentHost {
  private readonly sessions = new Map<string, Hosted>();
  private readonly subscriptions: HostDisposable[] = [];
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly integrationTimeoutMs: number;
  private readonly flushMs: number;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private client: HostClient | undefined;
  /** Relatórios saem em ordem: a saída antes do estado, o estado antes da saída. */
  private outbox: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: TerminalWindowApi,
    options: TerminalAgentHostOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 500;
    this.integrationTimeoutMs = options.integrationTimeoutMs ?? 15_000;
    this.flushMs = options.flushMs ?? 150;
    this.subscriptions.push(
      api.onDidChangeTerminalShellIntegration(({ terminal, shellIntegration }) => {
        const hosted = this.byTerminal(terminal);
        if (hosted && !hosted.execution) this.launch(hosted, shellIntegration);
      }),
      api.onDidEndTerminalShellExecution(({ terminal, execution, exitCode }) => {
        const hosted = this.byTerminal(terminal);
        if (hosted?.execution === execution) this.finished(hosted, exitCode);
      }),
      api.onDidCloseTerminal((terminal) => {
        const hosted = this.byTerminal(terminal);
        if (hosted) this.finished(hosted, terminal.exitStatus?.code);
      }),
    );
  }

  /** Chamado a cada conexão com o Core: se oferece como hospedeiro e diz o que ainda mantém. */
  connected(client: HostClient): void {
    this.client = client;
    const params: TerminalHostRegisterParams = {
      sessions: [...this.sessions.values()].filter((h) => !h.exited).map((h) => h.sessionId),
    };
    this.report(() => client.request('agents.terminalHost.register', params));
  }

  disconnected(): void {
    this.client = undefined;
  }

  /** Comando do Core (notificação `agents.terminalHost.command`). */
  onCommand(command: TerminalHostCommand): void {
    switch (command.type) {
      case 'spawn':
        this.spawn(command);
        return;
      case 'input':
        this.input(command.sessionId, command.text);
        return;
      case 'stop':
        this.stop(command.sessionId);
    }
  }

  /** Traz para a frente o terminal real do agente, para o usuário digitar nele ("Assumir"). */
  show(sessionId: string): boolean {
    const hosted = this.sessions.get(sessionId);
    if (!hosted || hosted.exited) return false;
    hosted.terminal.show();
    return true;
  }

  has(sessionId: string): boolean {
    const hosted = this.sessions.get(sessionId);
    return hosted !== undefined && !hosted.exited;
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const hosted of this.sessions.values()) {
      if (hosted.flushTimer) clearTimeout(hosted.flushTimer);
      if (hosted.integrationTimer) clearTimeout(hosted.integrationTimer);
    }
    for (const subscription of this.subscriptions) subscription.dispose();
    this.sessions.clear();
  }

  private spawn(request: Extract<TerminalHostCommand, { type: 'spawn' }>): void {
    if (this.sessions.has(request.sessionId)) return;
    let terminal: HostTerminal;
    try {
      terminal = this.api.createTerminal({
        name: l10n.t('Agent: {0} ({1})', request.nome, request.sessionId.slice(-6)),
        cwd: request.cwd,
        env: { ...request.env },
      });
    } catch (error) {
      this.send('exit', { sessionId: request.sessionId, error: String(error) });
      return;
    }
    const hosted: Hosted = {
      sessionId: request.sessionId,
      terminal,
      stream: new TerminalStream({
        prompt: request.prompt,
        silenceMs:
          request.silencioSegundos !== undefined ? request.silencioSegundos * 1000 : undefined,
      }),
      lines: [],
      flushTimer: undefined,
      integrationTimer: undefined,
      execution: undefined,
      exited: false,
      request,
    };
    this.sessions.set(request.sessionId, hosted);
    // Não rouba o foco: o usuário assume quando quiser ("Assumir o agente").
    terminal.show(true);
    this.send('ready', { sessionId: request.sessionId });
    this.startTicker();
    if (terminal.shellIntegration) {
      this.launch(hosted, terminal.shellIntegration);
      return;
    }
    // Sem integração de shell não há como ler a saída; espera um pouco e desiste com um motivo claro.
    hosted.integrationTimer = setTimeout(() => {
      if (hosted.execution || hosted.exited) return;
      hosted.exited = true;
      this.send('exit', {
        sessionId: hosted.sessionId,
        error: l10n.t(
          'the terminal has no shell integration, so the IDE cannot read the agent output; enable terminal.integrated.shellIntegration.enabled and use a supported shell (bash, zsh, fish or PowerShell)',
        ),
      });
    }, this.integrationTimeoutMs);
  }

  private launch(hosted: Hosted, integration: HostShellIntegration): void {
    if (hosted.execution || hosted.exited) return;
    if (hosted.integrationTimer) clearTimeout(hosted.integrationTimer);
    hosted.integrationTimer = undefined;
    const { command, args } = hosted.request;
    // Executável e argumentos do perfil, separados: nada que o agente escreve chega aqui.
    const execution = integration.executeCommand(command, [...args]);
    hosted.execution = execution;
    hosted.stream.start(this.now());
    // `read()` precisa ser chamado logo depois do `executeCommand`, senão perde o começo.
    void this.consume(hosted, execution);
  }

  private async consume(hosted: Hosted, execution: HostExecution): Promise<void> {
    try {
      for await (const chunk of execution.read()) {
        if (hosted.exited) return;
        this.accept(hosted, hosted.stream.push(chunk, this.now()));
      }
    } catch {
      // O fim do fluxo vem pelo evento de término da execução.
    }
  }

  private accept(
    hosted: Hosted,
    update: { readonly lines: readonly string[]; readonly state?: 'ocioso' | 'executando' },
  ): void {
    if (update.lines.length > 0) {
      hosted.lines.push(...update.lines);
      this.scheduleFlush(hosted);
    }
    if (update.state) {
      this.flush(hosted);
      this.send('state', { sessionId: hosted.sessionId, state: update.state });
    }
  }

  private scheduleFlush(hosted: Hosted): void {
    hosted.flushTimer ??= setTimeout(() => {
      this.flush(hosted);
    }, this.flushMs);
  }

  private flush(hosted: Hosted): void {
    if (hosted.flushTimer) clearTimeout(hosted.flushTimer);
    hosted.flushTimer = undefined;
    if (hosted.lines.length === 0) return;
    const text = hosted.lines.join('\n');
    hosted.lines = [];
    this.send('output', { sessionId: hosted.sessionId, text });
  }

  private input(sessionId: string, text: string): void {
    const hosted = this.sessions.get(sessionId);
    if (!hosted || hosted.exited) return;
    // Defesa em profundidade: o Core já limpou o texto, e aqui ele é limpo de novo.
    const line = sanitizeTerminalInput(text);
    if (line === '') return;
    hosted.terminal.sendText(line, true);
    const state = hosted.stream.input(this.now());
    if (state) this.send('state', { sessionId, state });
  }

  private stop(sessionId: string): void {
    const hosted = this.sessions.get(sessionId);
    if (!hosted) return;
    hosted.exited = true;
    this.cleanup(hosted);
    hosted.terminal.dispose();
    this.sessions.delete(sessionId);
  }

  /** A CLI terminou (ou o terminal fechou): a última linha sai e o Core fica sabendo. */
  private finished(hosted: Hosted, code: number | undefined): void {
    if (hosted.exited) return;
    hosted.exited = true;
    this.accept(hosted, hosted.stream.end());
    this.cleanup(hosted);
    this.send('exit', {
      sessionId: hosted.sessionId,
      ...(code !== undefined ? { code } : {}),
    });
  }

  private cleanup(hosted: Hosted): void {
    this.flush(hosted);
    if (hosted.integrationTimer) clearTimeout(hosted.integrationTimer);
    hosted.integrationTimer = undefined;
  }

  private startTicker(): void {
    this.ticker ??= setInterval(() => {
      for (const hosted of this.sessions.values()) {
        if (hosted.exited || !hosted.execution) continue;
        this.accept(hosted, hosted.stream.tick(this.now()));
      }
    }, this.tickMs);
  }

  private byTerminal(terminal: HostTerminal): Hosted | undefined {
    for (const hosted of this.sessions.values()) if (hosted.terminal === terminal) return hosted;
    return undefined;
  }

  private send(
    kind: 'ready' | 'output' | 'state' | 'exit',
    params: TerminalHostReportParams,
  ): void {
    const client = this.client;
    if (!client) return;
    this.report(() => client.request(`agents.terminalHost.${kind}`, params));
  }

  private report(call: () => Promise<unknown>): void {
    this.outbox = this.outbox.then(call).catch(() => {
      // O Core pode ter caído; ao reconectar, o registro diz o que ainda existe.
    });
  }
}
