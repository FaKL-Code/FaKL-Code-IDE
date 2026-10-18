import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type {
  AgentSessionInfo,
  AgentTerminalAttachResult,
  AgentTerminalLinesParams,
} from '@fakl/protocol';
import * as vscode from 'vscode';

import { readOnlyNotice, TerminalFeed, terminalTitle } from './terminal-model.js';

const GRAY = '\u001b[90m';
const RESET = '\u001b[0m';

/**
 * Terminal de leitura de um agente (ADR 0046): não há PTY por trás, só as
 * linhas que o Core monta dos eventos do agente. Teclas são ignoradas.
 */
class AgentPseudoterminal implements vscode.Pseudoterminal {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly closer = new vscode.EventEmitter<void>();
  private readonly feed = new TerminalFeed();
  private opened = false;
  private disposed = false;

  readonly onDidWrite = this.writer.event;
  readonly onDidClose = this.closer.event;

  constructor(
    private readonly sessionId: string,
    private readonly getClient: () => CoreClient | undefined,
    private readonly onClosed: () => void,
  ) {}

  open(): void {
    this.opened = true;
    this.writer.fire(readOnlyNotice());
    void this.attach();
  }

  close(): void {
    this.disposed = true;
    const client = this.getClient();
    void client?.request('agents.terminal.detach', { sessionId: this.sessionId }).catch(() => {
      // O Core pode já ter caído; o buffer lá some com a conexão.
    });
    this.writer.dispose();
    this.closer.dispose();
    this.onClosed();
  }

  /** Somente leitura: nada do que se digita vai para o agente. */
  handleInput(_data: string): void {
    // ignorado de propósito
  }

  /** Anexa (de novo, depois de uma reconexão) e escreve o que ainda não foi mostrado. */
  async attach(): Promise<void> {
    if (!this.opened || this.disposed) return;
    const client = this.getClient();
    if (!client) {
      this.write(`${GRAY}${l10n.t('FaKL Core is not responding.')}${RESET}\r\n`);
      return;
    }
    this.feed.begin();
    try {
      const result = await client.request<AgentTerminalAttachResult>('agents.terminal.attach', {
        sessionId: this.sessionId,
      });
      this.write(this.feed.history(result));
    } catch (error) {
      this.write(`${GRAY}${l10n.t('Could not open the terminal: {0}', String(error))}${RESET}\r\n`);
    }
  }

  lines(params: AgentTerminalLinesParams): void {
    this.write(this.feed.push(params));
  }

  lost(): void {
    this.write(
      `${GRAY}${l10n.t('Connection to the Core lost; the terminal continues when it returns.')}${RESET}\r\n`,
    );
  }

  private write(text: string): void {
    if (text && !this.disposed) this.writer.fire(text);
  }
}

interface Open {
  readonly terminal: vscode.Terminal;
  readonly pty: AgentPseudoterminal;
}

/** Um terminal de leitura por agente, alimentado pelas notificações do Core. */
export class AgentLiveTerminals implements vscode.Disposable {
  private readonly open = new Map<string, Open>();
  private readonly disposables: vscode.Disposable[] = [];
  private client: CoreClient | undefined;

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        for (const [id, entry] of this.open) {
          if (entry.terminal === closed) this.open.delete(id);
        }
      }),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    // Depois de reconectar, cada terminal aberto anexa de novo e completa o que perdeu.
    for (const { pty } of this.open.values()) void pty.attach();
  }

  disconnected(): void {
    this.client = undefined;
    for (const { pty } of this.open.values()) pty.lost();
  }

  /** Linhas novas de uma sessão, vindas do Core. */
  onLines(params: AgentTerminalLinesParams): void {
    this.open.get(params.sessionId)?.pty.lines(params);
  }

  /** Abre (ou traz para a frente) o terminal de leitura do agente. */
  show(session: Pick<AgentSessionInfo, 'sessionId' | 'nome'>): void {
    const existing = this.open.get(session.sessionId);
    if (existing) {
      existing.terminal.show();
      return;
    }
    const taken = new Set(vscode.window.terminals.map((t) => t.name));
    const pty = new AgentPseudoterminal(
      session.sessionId,
      () => this.client,
      () => {
        this.open.delete(session.sessionId);
      },
    );
    const terminal = vscode.window.createTerminal({
      name: terminalTitle(session.nome, session.sessionId, taken),
      pty,
      iconPath: new vscode.ThemeIcon('eye'),
    });
    this.open.set(session.sessionId, { terminal, pty });
    terminal.show();
  }

  dispose(): void {
    for (const { terminal } of [...this.open.values()]) terminal.dispose();
    this.open.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
