import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { UiOverlayParams, UiTakeRevealParams, UiTakeRevealResult } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import { revealSession } from './overlay-model.js';

export const MINIMIZE_COMMAND = 'fakl.overlay.minimize';

/** Janelas sem foco esperam um pouco antes de reclamar a conversa, para a focada ganhar. */
const UNFOCUSED_CLAIM_DELAY_MS = 400;

/**
 * Modo minimizado (ADR 0032): o comando e o item da barra de status pedem ao
 * Core que esconda a IDE e mostre o pet; o evento `ui.reveal` volta o foco para
 * a conversa de um agente quando ele é aberto pelo overlay.
 *
 * A conversa é reclamada no Core (`ui.takeReveal`), que a entrega uma vez só:
 * com várias janelas, só uma abre; sem nenhuma, a janela nova a recebe ao
 * conectar.
 */
export class OverlayControl implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private client: CoreClient | undefined;

  constructor(
    private readonly getClient: () => Promise<CoreClient | undefined>,
    router: AgentEventRouter,
  ) {
    const item = vscode.window.createStatusBarItem(
      'fakl.overlay',
      vscode.StatusBarAlignment.Right,
      90,
    );
    item.name = l10n.t('FaKL minimized mode');
    item.text = '$(chevron-down)';
    item.tooltip = l10n.t(
      'FaKL: Minimized mode (hides the IDE and leaves the agents in the overlay)',
    );
    item.command = MINIMIZE_COMMAND;
    item.show();
    this.disposables.push(
      item,
      vscode.commands.registerCommand(MINIMIZE_COMMAND, () => this.minimize()),
      router.listen((event) => {
        const sessionId = revealSession(event);
        if (sessionId) void this.claimReveal(sessionId);
      }),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.claimReveal();
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async claimReveal(sessionId?: string): Promise<void> {
    if (!vscode.window.state.focused) {
      await new Promise((resolve) => setTimeout(resolve, UNFOCUSED_CLAIM_DELAY_MS));
    }
    const client = this.client;
    if (!client) return;
    const params: UiTakeRevealParams = sessionId === undefined ? {} : { sessionId };
    try {
      const taken = await client.request<UiTakeRevealResult>('ui.takeReveal', params);
      if (taken)
        await vscode.commands.executeCommand('fakl.chat.open', { sessionId: taken.sessionId });
    } catch {
      // Core sem ui.takeReveal ou conexão caindo: nada a abrir.
    }
  }

  private async minimize(): Promise<void> {
    const client = await this.getClient();
    if (!client) {
      void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
      return;
    }
    const params: UiOverlayParams = { action: 'show', minimizeIde: true };
    try {
      await client.request('ui.overlay', params);
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t('Could not minimize: {0}', String(error)));
    }
  }
}
