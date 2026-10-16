import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type { ResourceSource } from '@fakl/protocol';
import * as vscode from 'vscode';

import { gitUrlProblem, sourceCounts, sourceDescription } from './resource-sources-model.js';

const VIEW_ID = 'fakl.resources.sources';
const HAS_SOURCES = 'fakl.resources.hasSources';

interface SourcePick extends vscode.QuickPickItem {
  readonly source: ResourceSource;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fontes de recursos (repositórios git ou pastas) cadastradas no Core. A IDE
 * não traz agentes, skills nem modelos de MCP: tudo o que "Instalar das
 * fontes" oferece vem daqui.
 */
export class ResourceSourcesView
  implements vscode.TreeDataProvider<ResourceSource>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private entries: readonly ResourceSource[] = [];
  private client: CoreClient | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor() {
    this.disposables.push(
      this.changed,
      vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this }),
      vscode.commands.registerCommand('fakl.resources.sources.add', () => this.add()),
      vscode.commands.registerCommand('fakl.resources.sources.list', () => this.list()),
      vscode.commands.registerCommand('fakl.resources.sources.update', () => this.update()),
      vscode.commands.registerCommand(
        'fakl.resources.sources.updateOne',
        (entry?: ResourceSource) =>
          entry ? this.update(entry) : this.pickThen((source) => this.update(source)),
      ),
      vscode.commands.registerCommand('fakl.resources.sources.remove', (entry?: ResourceSource) =>
        entry ? this.remove(entry) : this.pickThen((source) => this.remove(source)),
      ),
      vscode.commands.registerCommand(
        'fakl.resources.sources.reveal',
        (entry?: ResourceSource) =>
          entry && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.caminho)),
      ),
      vscode.commands.registerCommand('fakl.resources.sources.refresh', () => this.refresh()),
    );
    void vscode.commands.executeCommand('setContext', HAS_SOURCES, false);
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.reload();
  }

  disconnected(): void {
    this.client = undefined;
    this.entries = [];
    this.changed.fire(undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** Fontes como estão agora, para as views de instalação nomearem os grupos. */
  get sources(): readonly ResourceSource[] {
    return this.entries;
  }

  getTreeItem(entry: ResourceSource): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.nome);
    item.id = `source:${entry.id}`;
    item.description = sourceDescription(entry);
    item.iconPath = new vscode.ThemeIcon(
      entry.erro ? 'warning' : entry.tipo === 'git' ? 'repo' : 'folder',
    );
    item.contextValue = 'fakl.resource.source';
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(entry.nome);
    const field = (label: string, value?: string): void => {
      if (!value) return;
      tooltip.appendMarkdown(`\n\n**${label}:** `);
      tooltip.appendText(value);
    };
    field(l10n.t('Repository'), entry.url);
    field('Branch', entry.branch);
    field('Commit', entry.commit);
    field(l10n.t('Folder'), entry.caminho);
    field(l10n.t('Offers'), sourceCounts(entry));
    field(
      l10n.t('Updated on'),
      entry.atualizadaEm ? new Date(entry.atualizadaEm).toLocaleString() : undefined,
    );
    field(l10n.t('Error'), entry.erro);
    item.tooltip = tooltip;
    return item;
  }

  getChildren(entry?: ResourceSource): ResourceSource[] {
    return entry ? [] : [...this.entries];
  }

  private requireClient(): CoreClient | undefined {
    if (!this.client)
      void vscode.window.showWarningMessage(l10n.t('The FaKL Core is not responding.'));
    return this.client;
  }

  async reload(rethrow = false): Promise<readonly ResourceSource[]> {
    const client = this.client;
    if (!client) return this.entries;
    try {
      const sources = await client.request<ResourceSource[]>('sources.list');
      if (client !== this.client) return this.entries;
      this.entries = sources;
      void vscode.commands.executeCommand('setContext', HAS_SOURCES, sources.length > 0);
      this.changed.fire(undefined);
    } catch (error) {
      if (rethrow) throw error;
    }
    return this.entries;
  }

  private async refresh(): Promise<void> {
    if (!this.requireClient()) return;
    try {
      await this.reload(true);
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not read the resource sources: {0}', errorText(error)),
      );
    }
  }

  private async pickSource(placeHolder: string): Promise<ResourceSource | undefined> {
    const sources = await this.reload();
    if (sources.length === 0) {
      await this.offerAdd(l10n.t('No resource source added yet.'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      sources.map((source): SourcePick => ({
        label: source.nome,
        description: sourceDescription(source),
        detail: source.url ?? source.caminho,
        source,
      })),
      { title: l10n.t('Resource sources'), placeHolder },
    );
    return picked?.source;
  }

  private async pickThen(action: (source: ResourceSource) => Promise<void>): Promise<void> {
    if (!this.requireClient()) return;
    const source = await this.pickSource(l10n.t('Pick a source'));
    if (source) await action(source);
  }

  /** Sem fonte cadastrada: explica e oferece cadastrar uma. */
  async offerAdd(message: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      l10n.t(
        '{0} A resource source is a git repository or a folder with agents/, skills/ and mcps.json.',
        message,
      ),
      l10n.t('Add a resource source'),
    );
    if (choice) await this.add();
  }

  private async list(): Promise<void> {
    if (!this.requireClient()) return;
    const source = await this.pickSource(l10n.t('Pick a source to update, open or remove'));
    if (!source) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: l10n.t('$(sync) Update'), id: 'update' },
        { label: l10n.t('$(folder-opened) Open the folder'), id: 'reveal' },
        { label: l10n.t('$(trash) Remove'), id: 'remove' },
      ],
      { title: source.nome },
    );
    if (action?.id === 'update') await this.update(source);
    else if (action?.id === 'remove') await this.remove(source);
    else if (action?.id === 'reveal') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(source.caminho));
    }
  }

  private async add(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const kind = await vscode.window.showQuickPick(
      [
        {
          label: l10n.t('$(repo) Git repository'),
          detail: l10n.t(
            'Cloned and updated by the IDE. A private GitHub repository uses the connected account.',
          ),
          id: 'git' as const,
        },
        {
          label: l10n.t('$(folder) Local folder'),
          detail: l10n.t('Read in place; what you change in it shows up in the next install.'),
          id: 'pasta' as const,
        },
      ],
      { title: l10n.t('Add a resource source') },
    );
    if (!kind) return;
    let params: Record<string, string>;
    if (kind.id === 'git') {
      const url = await vscode.window.showInputBox({
        title: l10n.t('Add source: git repository'),
        prompt: l10n.t('Repository URL'),
        placeHolder: l10n.t('https://github.com/organization/resources.git'),
        ignoreFocusOut: true,
        validateInput: gitUrlProblem,
      });
      if (!url) return;
      const branch = await vscode.window.showInputBox({
        title: l10n.t('Add source: git repository'),
        prompt: l10n.t('Branch (empty for the repository default)'),
        ignoreFocusOut: true,
      });
      if (branch === undefined) return;
      params = { url: url.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) };
    } else {
      const folder = await vscode.window.showOpenDialog({
        title: l10n.t('Add source: local folder'),
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: l10n.t('Use as source'),
      });
      const uri = folder?.[0];
      if (!uri) return;
      params = { caminho: uri.fsPath };
    }
    try {
      const source = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            kind.id === 'git'
              ? l10n.t('Downloading the resource source…')
              : l10n.t('Reading the folder…'),
        },
        () => client.request<ResourceSource>('sources.add', params),
      );
      await this.reload();
      await this.afterAdd(source);
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not add the source: {0}', errorText(error)),
      );
    }
  }

  /** Nada é instalado sozinho: a mensagem leva direto à escolha. */
  private async afterAdd(source: ResourceSource): Promise<void> {
    const installAgents = l10n.t('Install agents');
    const installSkills = l10n.t('Install skills');
    const installMcps = l10n.t('Install MCP servers');
    const actions = [
      ...(source.agents > 0 ? [installAgents] : []),
      ...(source.skills > 0 ? [installSkills] : []),
      ...(source.mcps > 0 ? [installMcps] : []),
    ];
    const choice = await vscode.window.showInformationMessage(
      l10n.t(
        'Source {0} added: {1}. Nothing was installed; pick what to use.',
        source.nome,
        sourceCounts(source),
      ),
      ...actions,
    );
    if (choice === installAgents) {
      await vscode.commands.executeCommand('fakl.resources.agents.install');
    } else if (choice === installSkills) {
      await vscode.commands.executeCommand('fakl.resources.skills.install');
    } else if (choice === installMcps) {
      await vscode.commands.executeCommand('fakl.resources.mcpLibrary.install');
    }
  }

  private async update(source?: ResourceSource): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    try {
      const updated = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: source
            ? l10n.t('Updating {0}…', source.nome)
            : l10n.t('Updating the resource sources…'),
        },
        () => client.request<ResourceSource[]>('sources.update', source ? { id: source.id } : {}),
      );
      await this.reload();
      const failed = updated.filter((item) => item.erro);
      if (failed.length > 0) {
        void vscode.window.showWarningMessage(
          l10n.t(
            'Could not update: {0}',
            failed.map((item) => `${item.nome} (${item.erro ?? ''})`).join('; '),
          ),
        );
      } else if (updated.length > 0) {
        void vscode.window.showInformationMessage(
          updated.length === 1 && updated[0]
            ? l10n.t('{0} updated: {1}.', updated[0].nome, sourceCounts(updated[0]))
            : l10n.t('{0} sources updated.', updated.length),
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not update the sources: {0}', errorText(error)),
      );
    }
  }

  private async remove(source: ResourceSource): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const removeSource = l10n.t('Remove source');
    const choice = await vscode.window.showWarningMessage(
      l10n.t(
        'Remove the source {0}? What was already installed from it stays in the IDE.',
        source.nome,
      ),
      { modal: true },
      removeSource,
    );
    if (choice !== removeSource) return;
    try {
      await client.request<boolean>('sources.remove', { id: source.id });
      await this.reload();
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not remove {0}: {1}', source.nome, errorText(error)),
      );
    }
  }
}
