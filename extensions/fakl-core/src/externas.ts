import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { ExternalListResult, ExternalSession } from '@fakl/protocol';
import * as vscode from 'vscode';

const POLL_MS = 10_000;

/** Comando da extensão do Claude Code que abre uma conversa pelo id (não pré-preenche nada aqui). */
const CLAUDE_OPEN = 'claude-vscode.editor.open';
/** A extensão do Codex só abre o painel; não aceita id de conversa. */
const CODEX_OPEN = 'chatgpt.openSidebar';

/**
 * Conversas das extensões do Codex e do Claude Code na Mesa e no café (ADR 0039).
 * Só observa: o Core lê os metadados do disco, e a única ação é abrir a conversa
 * na extensão de origem. Nada é enviado a elas, porque não existe API para isso.
 */
export class ExternalSessionsFeed implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private client: CoreClient | undefined;
  private watchers = 0;
  private timer: NodeJS.Timeout | undefined;
  private current: ExternalListResult = { ativo: false, sessoes: [] };

  constructor() {
    this.disposables.push(
      vscode.commands.registerCommand('fakl.externas.ativar', () => this.enable()),
      vscode.commands.registerCommand('fakl.externas.desativar', () => this.disable()),
    );
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  connected(client: CoreClient): void {
    this.client = client;
    if (this.watchers > 0) void this.refresh();
  }

  disconnected(): void {
    this.client = undefined;
    this.set({ ativo: false, sessoes: [] });
  }

  get state(): ExternalListResult {
    return this.current;
  }

  /** Quem mostra as conversas pede para acompanhar; solta ao fechar. */
  watch(): vscode.Disposable {
    this.watchers++;
    this.timer ??= setInterval(() => void this.refresh(), POLL_MS);
    void this.refresh();
    let released = false;
    return {
      dispose: () => {
        if (released) return;
        released = true;
        this.watchers--;
        if (this.watchers === 0) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      },
    };
  }

  async refresh(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      this.set(await client.request<ExternalListResult>('external.list'));
    } catch {
      // Core reiniciando; a próxima rodada tenta de novo.
    }
  }

  private set(next: ExternalListResult): void {
    const same = JSON.stringify(next) === JSON.stringify(this.current);
    this.current = next;
    if (!same) this.changed.fire();
  }

  /** Liga a leitura depois de o usuário entender o que ela faz. */
  async enable(): Promise<void> {
    const allow = l10n.t('Allow');
    const answer = await vscode.window.showWarningMessage(
      l10n.t('Show the conversations of the Codex and Claude Code extensions?'),
      {
        modal: true,
        detail: l10n.t(
          'FaKL will read the local history files that the Codex and Claude Code extensions keep on this computer, to list their conversations on the Desk and in the café. Only the name, folder, time and state of each conversation are used; the messages are not shown, nothing is written to those files and nothing is sent anywhere. You can turn this off at any time.',
        ),
      },
      allow,
    );
    if (answer !== allow) return;
    await this.setEnabled(true);
  }

  async disable(): Promise<void> {
    await this.setEnabled(false);
  }

  private async setEnabled(ativo: boolean): Promise<void> {
    const client = this.client;
    if (!client) {
      void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
      return;
    }
    try {
      await client.request('external.setEnabled', { ativo });
      await this.refresh();
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  /** Abre a conversa na extensão de origem; a lista guardada vale, nunca o que veio do webview. */
  async open(id: string): Promise<void> {
    const session: ExternalSession | undefined = this.current.sessoes.find((s) => s.id === id);
    if (!session) return;
    const commands = await vscode.commands.getCommands(true);
    if (session.fonte === 'claude-code') {
      if (!commands.includes(CLAUDE_OPEN)) {
        void vscode.window.showWarningMessage(
          l10n.t('The Claude Code extension is not available.'),
        );
        return;
      }
      await vscode.commands.executeCommand(CLAUDE_OPEN, session.sessionId);
      return;
    }
    if (!commands.includes(CODEX_OPEN)) {
      void vscode.window.showWarningMessage(l10n.t('The Codex extension is not available.'));
      return;
    }
    await vscode.commands.executeCommand(CODEX_OPEN);
  }
}
