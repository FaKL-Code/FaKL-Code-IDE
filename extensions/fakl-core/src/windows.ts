import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { UsageWindowsResult } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import { bar } from './limits-model.js';
import {
  applyCaps,
  describeWindow,
  providerCaps,
  type ProviderWindows,
  rowName,
  rowWindows,
  untilReset,
  windowsText,
} from './windows-model.js';

const REFRESH_MS = 60_000;

/**
 * Sessões de 5 horas, cota diária e limite semanal dos planos, sempre à vista
 * na barra de status. As janelas vêm do Core (`usage.windows`), o mesmo que o
 * overlay lê; os tetos informados pelo usuário viram percentual aqui.
 */
export class UsageWindowsView implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly timer: NodeJS.Timeout;
  private readonly eventSubscription: vscode.Disposable;
  private readonly configSubscription: vscode.Disposable;
  private busy = false;
  private client: CoreClient | undefined;

  constructor(router: AgentEventRouter) {
    this.item = vscode.window.createStatusBarItem(
      'fakl.windows',
      vscode.StatusBarAlignment.Right,
      199,
    );
    this.item.name = l10n.t('Plan usage windows');
    this.item.command = 'fakl.windows.refresh';
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.eventSubscription = router.listen((event) => {
      if (event.topic === 'claude.account' || event.topic === 'config.changed') {
        void this.refresh();
      }
    });
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('fakl.limits')) void this.refresh();
    });
    void this.refresh();
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.refresh();
  }

  disconnected(): void {
    this.client = undefined;
    void this.refresh();
  }

  register(): vscode.Disposable {
    return vscode.commands.registerCommand('fakl.windows.refresh', () => this.refresh());
  }

  dispose(): void {
    clearInterval(this.timer);
    this.eventSubscription.dispose();
    this.configSubscription.dispose();
    this.item.dispose();
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.client
        ?.request<UsageWindowsResult>('usage.windows')
        .catch(() => undefined);
      const limits = vscode.workspace.getConfiguration('fakl.limits');
      const caps = providerCaps(limits.get('providers'), {
        sessionTokens: limits.get('claude.sessionTokens'),
        weeklyTokens: limits.get('claude.weeklyTokens'),
      });
      const rows = applyCaps(result?.janelas ?? [], caps);
      if (rows.length === 0) {
        this.item.hide();
        return;
      }
      this.item.text = windowsText(rows);
      this.item.tooltip = this.tooltip(rows, Date.now());
      this.item.show();
    } catch {
      this.item.hide();
    } finally {
      this.busy = false;
    }
  }

  private tooltip(rows: readonly ProviderWindows[], now: number): vscode.MarkdownString {
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${l10n.t('Plan usage windows')}**\n\n`);
    for (const row of rows) {
      const name = `**${rowName(row)}**`;
      if (row.semDados) {
        tip.appendMarkdown(
          `${l10n.t('{0} — no data: the CLI has not recorded usage on this machine yet', name)}\n\n`,
        );
        continue;
      }
      const origin =
        row.origem === 'real'
          ? l10n.t('{0} (provider percentage)', name)
          : l10n.t('{0} (estimated from local logs)', name);
      tip.appendMarkdown(`${origin}\n\n`);
      for (const { label, window } of rowWindows(row)) {
        const reset = untilReset(window?.resetaEm, now);
        const line = reset
          ? l10n.t('{0}: {1} — resets in {2}', label, describeWindow(window), reset)
          : `${label}: ${describeWindow(window)}`;
        tip.appendMarkdown(`\`${bar(window?.fracao)}\` ${line}\n\n`);
      }
    }
    tip.appendMarkdown(
      l10n.t(
        'No percentage until you set the plan cap in `fakl.limits.providers`. Click to refresh.',
      ),
    );
    return tip;
  }
}
