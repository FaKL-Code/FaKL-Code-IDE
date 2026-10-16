import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { LovableProject } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { GitHubUi } from './github.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lovable na IDE (RF-509, SDD 11.4): marca o repositório aberto como projeto
 * Lovable e abre o editor do Lovable. A entrega por merge envia o branch
 * acompanhado ao GitHub, e o Lovable mostra a mudança.
 */
export class LovableUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private client: CoreClient | undefined;

  constructor(private readonly github: GitHubUi) {
    this.disposables.push(
      vscode.commands.registerCommand('fakl.lovable.link', () => this.link()),
      vscode.commands.registerCommand('fakl.lovable.open', () => this.open()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
  }

  disconnected(): void {
    this.client = undefined;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async currentRepo(): Promise<string | undefined> {
    const repos = await this.github.repos();
    if (repos.length <= 1)
      return repos[0] ? `${repos[0].ref.owner}/${repos[0].ref.name}` : undefined;
    const picked = await vscode.window.showQuickPick(
      repos.map((r) => `${r.ref.owner}/${r.ref.name}`),
      { title: l10n.t('Repository') },
    );
    return picked;
  }

  private async link(): Promise<void> {
    if (!this.client) return;
    const repo = await this.currentRepo();
    if (!repo) {
      void vscode.window.showWarningMessage(
        l10n.t('Open the folder of the repository that Lovable syncs with GitHub.'),
      );
      return;
    }
    const projects = await this.client.request<LovableProject[]>('lovable.list');
    const existing = projects.find((p) => p.repo.toLowerCase() === repo.toLowerCase());
    const url = await vscode.window.showInputBox({
      title: l10n.t('Lovable project for {0}', repo),
      prompt: l10n.t('Project address on Lovable (empty to unlink)'),
      placeHolder: 'https://lovable.dev/projects/...',
      value: existing?.url ?? '',
      validateInput: (v) => (!v || v.startsWith('https://') ? undefined : l10n.t('Use https://')),
    });
    if (url === undefined) return;
    const branch = url
      ? await vscode.window.showInputBox({
          title: l10n.t('Branch that Lovable follows'),
          value: existing?.branch ?? 'main',
        })
      : undefined;
    if (url && !branch) return;
    const next = [
      ...projects.filter((p) => p.repo.toLowerCase() !== repo.toLowerCase()),
      ...(url && branch ? [{ repo, url, branch }] : []),
    ];
    try {
      await this.client.request('lovable.set', { projetos: next });
      void vscode.window.showInformationMessage(
        url
          ? l10n.t('{0} linked to Lovable.', repo)
          : l10n.t('{0} is no longer a Lovable project.', repo),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(message(error));
    }
  }

  private async open(): Promise<void> {
    if (!this.client) return;
    const projects = await this.client.request<LovableProject[]>('lovable.list');
    const repo = await this.currentRepo();
    const project =
      projects.find((p) => p.repo.toLowerCase() === repo?.toLowerCase()) ??
      (projects.length > 0
        ? (
            await vscode.window.showQuickPick(
              projects.map((p) => ({ label: p.repo, description: p.url, project: p })),
              { title: l10n.t('Lovable project') },
            )
          )?.project
        : undefined);
    if (!project) {
      const link = await vscode.window.showInformationMessage(
        l10n.t('No Lovable project linked to this repository.'),
        l10n.t('Link now'),
      );
      if (link) await this.link();
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(project.url));
  }
}
