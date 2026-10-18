import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import {
  SCORECARD_MIN_TASKS,
  SCORECARD_PERIODS,
  type ScorecardEntry,
  type ScorecardPeriod,
  type ScorecardResult,
} from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import {
  entryDescription,
  entryTooltipLines,
  hasEnoughData,
  periodLabel,
} from './scorecard-model.js';

const PERIOD_KEY = 'fakl.scorecard.periodo';
/** Eventos que mudam o placar; os de uso chegam em rajada, então a atualização espera um pouco. */
const TOPICS = new Set(['run.done', 'agent.review', 'agent.recovery', 'cost.update', 'run.limit']);

/**
 * Placar dos agentes (ADR 0043): uma linha por perfil, com o período
 * escolhido, a taxa de aprovação do diff, a duração e o custo médios. Os
 * detalhes ficam no tooltip. Os números vêm do Core; nada sai da máquina.
 */
export class ScorecardView implements vscode.TreeDataProvider<ScorecardEntry>, vscode.Disposable {
  private result: ScorecardResult | undefined;
  private period: ScorecardPeriod;
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tree: vscode.TreeView<ScorecardEntry>;
  private client: CoreClient | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    router: AgentEventRouter,
    private readonly state: vscode.Memento,
  ) {
    const saved = state.get<string>(PERIOD_KEY);
    this.period = SCORECARD_PERIODS.find((p) => p === saved) ?? '30d';
    this.tree = vscode.window.createTreeView('fakl.scorecard', { treeDataProvider: this });
    this.tree.description = periodLabel(this.period);
    this.disposables.push(
      this.changed,
      this.tree,
      router.listen((event) => {
        if (TOPICS.has(event.topic)) this.scheduleReload();
      }),
      vscode.commands.registerCommand('fakl.scorecard.setPeriod', () => this.pickPeriod()),
      vscode.commands.registerCommand('fakl.scorecard.reset', () => this.reset()),
      vscode.commands.registerCommand('fakl.scorecard.refresh', () => this.reload()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.reload();
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  getTreeItem(entry: ScorecardEntry): vscode.TreeItem {
    const minimum = this.result?.amostraMinima ?? SCORECARD_MIN_TASKS;
    const item = new vscode.TreeItem(entry.nome);
    item.id = entry.perfilId;
    item.description = entryDescription(entry, minimum);
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(entryTooltipLines(entry, minimum).join('\n\n'));
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon(
      entry.removido ? 'circle-slash' : hasEnoughData(entry, minimum) ? 'graph' : 'graph-line',
    );
    item.contextValue = 'fakl.scorecard.profile';
    return item;
  }

  getChildren(entry?: ScorecardEntry): ScorecardEntry[] {
    return entry ? [] : [...(this.result?.perfis ?? [])];
  }

  private scheduleReload(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reload();
    }, 2000);
  }

  private async reload(): Promise<void> {
    if (!this.client) return;
    try {
      this.result = await this.client.request<ScorecardResult>('scorecard.get', {
        periodo: this.period,
      });
      this.tree.description = periodLabel(this.period);
      if (this.result.perfis.length === 0) {
        this.tree.message = l10n.t('No agent activity recorded in this period yet.');
      } else {
        this.tree.message = '';
      }
    } catch {
      this.result = undefined;
    }
    this.changed.fire(undefined);
  }

  private async pickPeriod(): Promise<void> {
    const items = SCORECARD_PERIODS.map((period) => ({
      label: periodLabel(period),
      ...(period === this.period ? { description: l10n.t('current') } : {}),
      period,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: l10n.t('Agent scorecard: period'),
    });
    if (!picked) return;
    this.period = picked.period;
    await this.state.update(PERIOD_KEY, this.period);
    await this.reload();
  }

  private async reset(): Promise<void> {
    if (!this.client) {
      void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
      return;
    }
    const confirm = l10n.t('Reset scorecard');
    const choice = await vscode.window.showWarningMessage(
      l10n.t('Reset the agent scorecard?'),
      {
        modal: true,
        detail: l10n.t(
          'This erases the counters of every profile and every period. It cannot be undone.',
        ),
      },
      confirm,
    );
    if (choice !== confirm) return;
    try {
      await this.client.request('scorecard.reset');
      await this.reload();
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }
}
