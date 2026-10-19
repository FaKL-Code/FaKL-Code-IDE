import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import {
  linhasDoResumo,
  modoDescricao,
  modoRotulo,
  textoDaBarra,
  type EconomiaResumo,
} from './economia-model.js';

const MODOS: readonly EconomiaResumo['modo'][] = ['equilibrado', 'agressivo', 'desligado'];
const REFRESH_MS = 60_000;

/**
 * Economia de tokens (ADR 0052): o item da barra de status mostra quanto já se
 * economizou hoje, e o clique abre o resumo, onde se troca o modo. Os números
 * vêm do Core (`economia.status`); nada sai da máquina.
 */
export class EconomiaView implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private client: CoreClient | undefined;
  private resumo: EconomiaResumo | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(router: AgentEventRouter) {
    this.item = vscode.window.createStatusBarItem(
      'fakl.economia',
      vscode.StatusBarAlignment.Right,
      190,
    );
    this.item.name = l10n.t('Token saving');
    this.item.command = 'fakl.economia.show';
    this.disposables.push(
      this.item,
      // O custo muda a cada rodada de agente: bom momento para reler.
      router.listen((event) => {
        if (event.topic === 'run.done') void this.refresh();
      }),
      vscode.commands.registerCommand('fakl.economia.show', () => this.show()),
      vscode.commands.registerCommand('fakl.economia.setMode', () => this.pickMode()),
      vscode.commands.registerCommand('fakl.economia.reset', () => this.reset()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  disconnected(): void {
    this.client = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    this.item.hide();
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async refresh(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      this.resumo = await client.request<EconomiaResumo>('economia.status');
    } catch {
      this.item.hide();
      return;
    }
    this.item.text = textoDaBarra(this.resumo);
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(linhasDoResumo(this.resumo).join('\n\n'));
    this.item.tooltip = tooltip;
    this.item.show();
  }

  private async show(): Promise<void> {
    await this.refresh();
    const resumo = this.resumo;
    if (!resumo) return;
    const change = l10n.t('Change mode');
    const zero = l10n.t('Reset counters');
    const choice = await vscode.window.showInformationMessage(
      linhasDoResumo(resumo).join('\n'),
      { modal: true, detail: modoDescricao(resumo.modo) },
      change,
      zero,
    );
    if (choice === change) await this.pickMode();
    if (choice === zero) await this.reset();
  }

  private async pickMode(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const atual = this.resumo?.modo;
    const picked = await vscode.window.showQuickPick(
      MODOS.map((modo) => ({
        label: modoRotulo(modo),
        description: modo === atual ? l10n.t('current') : '',
        detail: modoDescricao(modo),
        modo,
      })),
      {
        title: l10n.t('Token saving mode'),
        placeHolder: l10n.t('Applies to the agents you start from now on'),
      },
    );
    if (!picked || picked.modo === atual) return;
    this.resumo = await client.request<EconomiaResumo>('economia.setModo', { modo: picked.modo });
    await this.refresh();
  }

  private async reset(): Promise<void> {
    const client = this.client;
    if (!client) return;
    await client.request('economia.reset');
    await this.refresh();
  }
}
