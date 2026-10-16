import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import type {
  CatalogResourceInfo,
  ResourceCatalog,
  ResourceContent,
  ResourceInfo,
  ResourceKind,
  ResourceLibrary,
} from '@fakl/protocol';
import * as vscode from 'vscode';

import { groupOffered, namesBySource } from './resource-sources-model.js';
import type { ResourceSourcesView } from './resource-sources.js';

const VIEW_IDS: Record<ResourceKind, string> = {
  agent: 'fakl.resources.agents',
  skill: 'fakl.resources.skills',
};

const RELOAD_DEBOUNCE_MS = 300;

/** Textos da instalação, um conjunto por tipo (frases inteiras, sem montar o plural). */
function installTexts(kind: ResourceKind): {
  noSources: string;
  allInstalled: string;
  noneOffered: string;
  title: string;
  placeHolder: string;
  failed: (error: string) => string;
} {
  return kind === 'agent'
    ? {
        noSources: l10n.t('No resource source added yet to install agents.'),
        allInstalled: l10n.t('All agents from the sources are already installed.'),
        noneOffered: l10n.t('The added sources have no agents.'),
        title: l10n.t('Install agents from the sources'),
        placeHolder: l10n.t('Pick one or more agents; nothing is installed unless you choose it'),
        failed: (error) => l10n.t('Could not install agents: {0}', error),
      }
    : {
        noSources: l10n.t('No resource source added yet to install skills.'),
        allInstalled: l10n.t('All skills from the sources are already installed.'),
        noneOffered: l10n.t('The added sources have no skills.'),
        title: l10n.t('Install skills from the sources'),
        placeHolder: l10n.t('Pick one or more skills; nothing is installed unless you choose it'),
        failed: (error) => l10n.t('Could not install skills: {0}', error),
      };
}

interface CatalogPick extends vscode.QuickPickItem {
  readonly entry?: CatalogResourceInfo;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detail(info: ResourceInfo): string | undefined {
  const parts = [info.nivel, info.perfil].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

function appendField(tooltip: vscode.MarkdownString, label: string, value?: string): void {
  if (!value) return;
  tooltip.appendMarkdown(`\n\n**${label}:** `);
  tooltip.appendText(value);
}

class ResourceTree implements vscode.TreeDataProvider<ResourceInfo>, vscode.Disposable {
  private entries: readonly ResourceInfo[] = [];
  private readonly changed = new vscode.EventEmitter<undefined>();

  readonly onDidChangeTreeData = this.changed.event;

  setEntries(entries: readonly ResourceInfo[]): void {
    this.entries = entries;
    this.changed.fire(undefined);
  }

  getTreeItem(entry: ResourceInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.name);
    item.id = `${entry.kind}:${entry.name}`;
    const description = detail(entry);
    if (description) item.description = description;
    item.iconPath = new vscode.ThemeIcon(entry.kind === 'agent' ? 'hubot' : 'lightbulb');
    item.contextValue = `fakl.resource.library.${entry.kind}`;
    item.command = {
      command: 'fakl.resources.open',
      title: l10n.t('Open'),
      arguments: [entry],
    };

    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(entry.name);
    if (entry.description) {
      tooltip.appendMarkdown('\n\n');
      tooltip.appendText(entry.description);
    }
    appendField(tooltip, l10n.t('Model'), entry.modelo);
    appendField(tooltip, l10n.t('Alternative'), entry.alternativa);
    appendField(tooltip, l10n.t('License'), entry.licenca);
    appendField(tooltip, l10n.t('Sources'), entry.fontes?.join(', '));
    item.tooltip = tooltip;
    return item;
  }

  getChildren(entry?: ResourceInfo): ResourceInfo[] {
    return entry ? [] : [...this.entries];
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Agentes e skills instalados na biblioteca global da IDE, mantida pelo Core. */
export class AiResourcesView implements vscode.Disposable {
  private readonly agents = new ResourceTree();
  private readonly skills = new ResourceTree();
  private readonly disposables: vscode.Disposable[] = [];
  private client: CoreClient | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private watchedDir: string | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly sources: ResourceSourcesView) {
    this.disposables.push(
      this.agents,
      this.skills,
      vscode.window.createTreeView(VIEW_IDS.agent, { treeDataProvider: this.agents }),
      vscode.window.createTreeView(VIEW_IDS.skill, { treeDataProvider: this.skills }),
      vscode.commands.registerCommand('fakl.resources.agents.install', () => this.install('agent')),
      vscode.commands.registerCommand('fakl.resources.skills.install', () => this.install('skill')),
      vscode.commands.registerCommand('fakl.resources.agents.create', () => this.create('agent')),
      vscode.commands.registerCommand('fakl.resources.skills.create', () => this.create('skill')),
      vscode.commands.registerCommand('fakl.resources.agents.refresh', () => this.refresh()),
      vscode.commands.registerCommand('fakl.resources.skills.refresh', () => this.refresh()),
      vscode.commands.registerCommand('fakl.resources.open', (entry?: ResourceInfo) =>
        this.open(entry),
      ),
      vscode.commands.registerCommand('fakl.resources.remove', (entry?: ResourceInfo) =>
        this.remove(entry),
      ),
    );
    void vscode.commands.executeCommand('setContext', 'fakl.resources.coreConnected', false);
  }

  connected(client: CoreClient): void {
    this.client = client;
    void vscode.commands.executeCommand('setContext', 'fakl.resources.coreConnected', true);
    void this.reload();
  }

  disconnected(): void {
    this.client = undefined;
    this.unwatch();
    this.agents.setEntries([]);
    this.skills.setEntries([]);
    void vscode.commands.executeCommand('setContext', 'fakl.resources.coreConnected', false);
  }

  dispose(): void {
    this.unwatch();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private requireClient(): CoreClient | undefined {
    if (!this.client)
      void vscode.window.showWarningMessage(l10n.t('The FaKL Core is not responding.'));
    return this.client;
  }

  /** Atualizar pelo título da view: aqui a falha precisa aparecer. */
  private async refresh(): Promise<void> {
    if (!this.requireClient()) return;
    try {
      await this.reload(true);
    } catch (error) {
      this.showError(l10n.t('Could not update the AI resources: {0}', errorText(error)));
    }
  }

  private async reload(rethrow = false): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const result = await client.request<ResourceLibrary>('resources.list');
      if (client !== this.client) return;
      this.agents.setEntries(result.agents);
      this.skills.setEntries(result.skills);
      this.watch(result.dir);
    } catch (error) {
      // Sem pedido do usuário, a reconexão da extensão fará uma nova leitura.
      if (rethrow) throw error;
    }
  }

  private watch(dir: string): void {
    if (dir === this.watchedDir) return;
    this.unwatch();
    this.watchedDir = dir;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), '**'),
    );
    // Instalar uma skill grava vários arquivos: uma leitura só para a rajada.
    const schedule = (): void => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = undefined;
        void this.reload();
      }, RELOAD_DEBOUNCE_MS);
    };
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidChange(schedule);
    this.watcher.onDidDelete(schedule);
  }

  private unwatch(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.watchedDir = undefined;
  }

  private async install(kind: ResourceKind): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const texts = installTexts(kind);
    try {
      const sources = await this.sources.reload();
      if (sources.length === 0) {
        await this.sources.offerAdd(texts.noSources);
        return;
      }
      const catalog = await client.request<ResourceCatalog>('resources.catalog');
      const offered = kind === 'agent' ? catalog.agents : catalog.skills;
      const groups = groupOffered(offered, sources);
      if (!groups.length) {
        void vscode.window.showInformationMessage(
          offered.length ? texts.allInstalled : texts.noneOffered,
        );
        return;
      }
      const items = groups.flatMap((group): CatalogPick[] => [
        { label: group.nome, kind: vscode.QuickPickItemKind.Separator },
        ...group.items.map((entry): CatalogPick => {
          const description = [entry.padrao === false ? '' : l10n.t('recommended'), detail(entry)]
            .filter(Boolean)
            .join(' · ');
          return {
            label: entry.name,
            detail: entry.description,
            ...(description ? { description } : {}),
            entry,
          };
        }),
      ]);
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
        title: texts.title,
        placeHolder: texts.placeHolder,
      });
      const chosen = (picked ?? []).flatMap(({ entry }) => (entry ? [entry] : []));
      if (!chosen.length) return;
      for (const [fonte, names] of namesBySource(chosen)) {
        await client.request<ResourceInfo[]>('resources.install', { kind, names, fonte });
      }
      await this.reload();
    } catch (error) {
      this.showError(texts.failed(errorText(error)));
    }
  }

  private async create(kind: ResourceKind): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const title = kind === 'agent' ? l10n.t('New agent') : l10n.t('New skill');
    const name = await vscode.window.showInputBox({
      title,
      prompt: kind === 'agent' ? l10n.t('Agent name') : l10n.t('Skill name'),
      validateInput: (value) => (value.trim() ? undefined : l10n.t('Enter a name.')),
    });
    if (!name) return;
    const description = await vscode.window.showInputBox({
      title,
      prompt:
        kind === 'agent'
          ? l10n.t('Agent description (optional)')
          : l10n.t('Skill description (optional)'),
    });
    if (description === undefined) return;
    try {
      const created = await client.request<ResourceInfo>('resources.create', {
        kind,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      await this.reload();
      await vscode.window.showTextDocument(vscode.Uri.file(created.path));
    } catch (error) {
      this.showError(
        kind === 'agent'
          ? l10n.t('Could not create the agent: {0}', errorText(error))
          : l10n.t('Could not create the skill: {0}', errorText(error)),
      );
    }
  }

  private async open(entry?: ResourceInfo): Promise<void> {
    if (!entry) return;
    const client = this.requireClient();
    if (!client) return;
    try {
      const resource = await client.request<ResourceContent>('resources.get', {
        kind: entry.kind,
        name: entry.name,
      });
      await vscode.window.showTextDocument(vscode.Uri.file(resource.info.path));
    } catch (error) {
      this.showError(l10n.t('Could not open {0}: {1}', entry.name, errorText(error)));
    }
  }

  private async remove(entry?: ResourceInfo): Promise<void> {
    if (!entry) return;
    const client = this.requireClient();
    if (!client) return;
    const removeFromIde = l10n.t('Remove from the IDE');
    const choice = await vscode.window.showWarningMessage(
      l10n.t('Remove {0} from the IDE?', entry.name),
      { modal: true },
      removeFromIde,
    );
    if (choice !== removeFromIde) return;
    try {
      await client.request<boolean>('resources.remove', {
        kind: entry.kind,
        name: entry.name,
      });
      await this.reload();
    } catch (error) {
      this.showError(l10n.t('Could not remove {0}: {1}', entry.name, errorText(error)));
    }
  }

  private showError(message: string): void {
    void vscode.window.showErrorMessage(message);
  }
}
