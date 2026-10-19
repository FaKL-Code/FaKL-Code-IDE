import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { CiStatus, GitHubAccountRepo } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import { parseRepoInput, repoChoices, statusBarView, WATCHED_SETTING } from './ci-model.js';
import { readNetworkSettings } from './rede.js';

/** Quantos repositórios o Core acompanha (`MAX_WATCHED_REPOS`); só para a mensagem. */
const LIMIT = 5;

/**
 * Café do CI na IDE (ADR 0051): diz ao Core quais repositórios acompanhar (as
 * pastas abertas e os marcados em `fakl.ci.repositorios`), mostra o número de
 * fluxos falhando na barra de status e oferece os comandos. A cozinha em si
 * fica na tela própria (`ci-panel.ts`). Nada é consultado aqui: tudo vem do Core, que só
 * fala com o GitHub com a conta conectada e, sozinho, com o interruptor
 * `fakl.rede.consultasAutomaticas` ligado.
 */
export class CiUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly item: vscode.StatusBarItem;
  private client: CoreClient | undefined;
  private timer: NodeJS.Timeout | undefined;
  private warnedAbout = '';

  constructor(router: AgentEventRouter) {
    this.item = vscode.window.createStatusBarItem('fakl.ci', vscode.StatusBarAlignment.Left, 98);
    this.item.name = l10n.t('CI of the followed repositories');
    this.item.command = 'fakl.ci.open';
    this.disposables.push(
      this.item,
      router.listen((event) => {
        if (event.topic === 'ci.run') this.scheduleStatus();
      }),
      vscode.commands.registerCommand('fakl.ci.acompanhar', () => this.choose()),
      vscode.commands.registerCommand('fakl.ci.atualizar', () => this.refreshNow()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`fakl.${WATCHED_SETTING}`) ||
          event.affectsConfiguration('fakl.rede.consultasAutomaticas')
        ) {
          void this.pushWatch();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.pushWatch();
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.pushWatch();
  }

  disconnected(): void {
    this.client = undefined;
    this.item.hide();
  }

  private marked(): string[] {
    const value = vscode.workspace.getConfiguration('fakl').get<unknown>(WATCHED_SETTING, []);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  /** Entrega ao Core quem acompanhar e o valor do interruptor; o Core responde com o retrato. */
  private async pushWatch(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const status = await client.request<CiStatus>('ci.watch.set', {
        repos: this.marked(),
        pastas: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        automatico: readNetworkSettings().automatic,
      });
      this.show(status);
      const dropped = status.descartados.join(', ');
      if (dropped && dropped !== this.warnedAbout) {
        this.warnedAbout = dropped;
        void vscode.window.showWarningMessage(
          l10n.t(
            'The café follows at most {0} repositories; not followed now: {1}',
            String(LIMIT),
            dropped,
          ),
        );
      }
    } catch {
      this.item.hide();
    }
  }

  private scheduleStatus(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.client
        ?.request<CiStatus>('ci.status', {})
        .then((status) => {
          this.show(status);
        })
        .catch(() => undefined);
    }, 1000);
  }

  private show(status: CiStatus): void {
    const view = statusBarView(status);
    if (!view.visible) {
      this.item.hide();
      return;
    }
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.backgroundColor = view.warn
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  /** Consulta o GitHub agora, a pedido do usuário (vale com o interruptor desligado). */
  private async refreshNow(): Promise<void> {
    const client = this.client;
    if (!client) {
      void vscode.window.showWarningMessage(l10n.t('FaKL Core is not connected.'));
      return;
    }
    try {
      this.show(await client.request<CiStatus>('ci.status', { atualizar: true }));
    } catch (error) {
      void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error));
    }
  }

  /** "Acompanhar o CI de um repositório": escolhe, entre os da conta, os que o café acompanha. */
  private async choose(): Promise<void> {
    const client = this.client;
    if (!client) {
      void vscode.window.showWarningMessage(l10n.t('FaKL Core is not connected.'));
      return;
    }
    let account: string[] = [];
    try {
      const list = await client.request<GitHubAccountRepo[]>('github.account.repos.list', {
        limite: 100,
      });
      account = list.map((r) => r.repo);
    } catch {
      // Sem a lista da conta (sem login, sem rede): ainda dá para digitar o nome.
    }
    const watched = this.marked();
    const items: (vscode.QuickPickItem & { repo?: string; manual?: boolean })[] = [
      { label: l10n.t('Type a repository (owner/name)...'), manual: true },
      ...repoChoices(watched, account).map((choice) => ({
        label: choice.repo,
        repo: choice.repo,
        picked: choice.picked,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: l10n.t('Follow the CI of repositories'),
      placeHolder: l10n.t(
        'Up to {0} repositories, counting the one open in the IDE. The café shows their runs.',
        String(LIMIT),
      ),
    });
    if (!picked) return;
    const chosen = picked.flatMap((item) => item.repo ?? []);
    if (picked.some((item) => item.manual)) {
      const typed = await vscode.window.showInputBox({
        prompt: l10n.t('Repository to follow, as owner/name or a github.com address'),
        validateInput: (value) =>
          value && !parseRepoInput(value) ? l10n.t('Use the form owner/name') : undefined,
      });
      const repo = typed ? parseRepoInput(typed) : undefined;
      if (repo) chosen.push(repo);
    }
    await vscode.workspace
      .getConfiguration('fakl')
      .update(WATCHED_SETTING, chosen, vscode.ConfigurationTarget.Global);
    // Sem esperar o evento de mudança da configuração: o Core precisa da lista nova antes da leitura.
    await this.pushWatch();
    await this.refreshNow();
    if (chosen.length > 0) await vscode.commands.executeCommand('fakl.ci.open');
  }
}
