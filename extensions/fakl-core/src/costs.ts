import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CoreClient } from '@fakl/core';
import { currentLocale, l10n } from '@fakl/i18n';
import type { AgentProfileEntry, CostSummary, CostTotals, DailyCapEventData } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import { bar, providerLimits, statusText, worstLevel } from './limits-model.js';

function money(value: number): string {
  return l10n.t('${0}', value.toFixed(2));
}

function describe(totals: CostTotals): string {
  const tokens = totals.tokensEntrada + totals.tokensSaida;
  return `${money(totals.custoUsd)} · ${l10n.t('{0} tokens', tokens.toLocaleString(currentLocale()))}`;
}

/** Gasto do dia e aviso de teto diário (RNF-13). */
export class CostsView implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private client: CoreClient | undefined;
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;

  constructor(router: AgentEventRouter) {
    this.item = vscode.window.createStatusBarItem(
      'fakl.limits',
      vscode.StatusBarAlignment.Right,
      200,
    );
    this.item.name = l10n.t('Agent usage limits');
    this.item.command = 'fakl.costs.show';
    this.disposables.push(
      this.item,
      router.listen((event) => {
        if (event.topic === 'cost.update' || event.topic === 'run.limit') this.scheduleRefresh();
        if (event.topic === 'run.limit') {
          const data = event.data as Partial<DailyCapEventData>;
          if (data.tipo === 'teto-diario') void this.warn(data as DailyCapEventData);
        }
      }),
      vscode.commands.registerCommand('fakl.costs.show', () => this.show()),
      vscode.commands.registerCommand('fakl.costs.editCaps', () => this.editCaps()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    this.scheduleRefresh(0);
  }

  disconnected(): void {
    this.client = undefined;
    this.item.hide();
  }

  /** Agrupa rajadas de `cost.update` num pedido só. */
  private scheduleRefresh(delay = 1000): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  /** Item da barra de status: uso do dia de todos os provedores, sempre à vista. */
  private async refresh(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const [summary, entries] = await Promise.all([
        client.request<CostSummary>('costs.summary'),
        client.request<AgentProfileEntry[]>('profiles.list'),
      ]);
      const rows = providerLimits(
        summary,
        entries.map((entry) => entry.profile.provedor),
      );
      const level = worstLevel(rows);
      this.item.text = statusText(rows, summary.total);
      this.item.backgroundColor =
        level === 'error'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : level === 'warn'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
      const tooltip = new vscode.MarkdownString(undefined, true);
      tooltip.appendMarkdown(`${l10n.t('**Usage today ({0})** — {1}', summary.dia, describe(summary.total))}

`);
      for (const row of rows) {
        const pct = row.fracao === undefined ? '' : ` ${String(Math.round(row.fracao * 100))}%`;
        const cap = row.teto ? ` / ${row.teto}` : ` (${l10n.t('no cap')})`;
        const mark = row.bloqueado ? ` $(error) ${l10n.t('blocked')}` : '';
        tooltip.appendMarkdown(
          `\`${bar(row.fracao)}\`${pct} **${row.provedor}** ${row.gasto}${cap}${mark}

`,
        );
      }
      tooltip.appendMarkdown(l10n.t('Click for details and to adjust caps.'));
      this.item.tooltip = tooltip;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async warn(data: DailyCapEventData): Promise<void> {
    const gasto =
      data.limite === 'custoUsd' ? money(data.gasto) : l10n.t('{0} tokens', String(data.gasto));
    const ajustar = l10n.t('Adjust cap');
    const ver = l10n.t('View spending');
    const choice = await vscode.window.showWarningMessage(
      data.pausadas.length === 1
        ? l10n.t(
            'Daily cap for {0} reached ({1}). 1 agent paused; new messages to this provider are blocked until tomorrow.',
            data.provedor,
            gasto,
          )
        : l10n.t(
            'Daily cap for {0} reached ({1}). {2} agents paused; new messages to this provider are blocked until tomorrow.',
            data.provedor,
            gasto,
            String(data.pausadas.length),
          ),
      ajustar,
      ver,
    );
    if (choice === ajustar) await this.editCaps();
    else if (choice === ver) await this.show();
  }

  private async editCaps(): Promise<void> {
    const file = vscode.Uri.file(join(homedir(), '.fakl', 'config.yaml'));
    await vscode.window.showTextDocument(file);
  }

  private async show(): Promise<void> {
    if (!this.client) {
      void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
      return;
    }
    const summary = await this.client.request<CostSummary>('costs.summary');
    const providers = new Set([...Object.keys(summary.porProvedor), ...Object.keys(summary.tetos)]);
    const items: vscode.QuickPickItem[] = [
      { label: l10n.t("Today's total ({0})", summary.dia), description: describe(summary.total) },
      { label: l10n.t('By provider'), kind: vscode.QuickPickItemKind.Separator },
      ...[...providers].map((provedor): vscode.QuickPickItem => {
        const cap = summary.tetos[provedor];
        const limits = [
          cap?.custoUsd !== undefined ? money(cap.custoUsd) : undefined,
          cap?.tokens !== undefined
            ? l10n.t('{0} tokens', cap.tokens.toLocaleString(currentLocale()))
            : undefined,
        ].filter((limit): limit is string => limit !== undefined);
        return {
          label: `${summary.bloqueados.includes(provedor) ? '$(error) ' : ''}${provedor}`,
          description: describe(
            summary.porProvedor[provedor] ?? { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 },
          ),
          detail:
            limits.length === 0
              ? l10n.t('No daily cap')
              : limits.length === 1
                ? l10n.t('Daily cap: {0}', limits[0] ?? '')
                : l10n.t('Daily cap: {0} or {1}', limits[0] ?? '', limits[1] ?? ''),
        };
      }),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(edit) ${l10n.t('Adjust caps in config.yaml')}` },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: l10n.t('Agent spending') });
    if (picked?.label.startsWith('$(edit)')) await this.editCaps();
  }
}
