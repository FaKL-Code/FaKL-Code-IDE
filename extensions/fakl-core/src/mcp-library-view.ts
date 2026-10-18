import type { CoreClient } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import {
  mcpSecretName,
  type InstalledMcpServer,
  type McpCatalog,
  type McpCatalogServer,
  type McpInputSpec,
  type McpLibraryInfo,
  type McpServerEntry,
} from '@fakl/protocol';
import * as vscode from 'vscode';

import {
  needsConfirmation,
  riskConfirmation,
  riskSummary,
  riskTooltip,
  worstRisk,
} from './resource-risk-model.js';
import { groupOffered, namesBySource } from './resource-sources-model.js';
import type { ResourceSourcesView } from './resource-sources.js';

const VIEW_ID = 'fakl.resources.mcpLibrary';
/** Chave no SecretStorage de cada `${input:id}`; o valor nunca vai para disco em texto. */
const SECRET_PREFIX = 'fakl.mcp.secret.';
/** Ids guardados, para reenviar ao Core a cada conexão (o SecretStorage não lista chaves). */
const INDEX_KEY = 'fakl.mcp.secretIds';
const RELEVANCE_ORDER = { alta: 0, média: 1, baixa: 2 } as const;

interface CatalogPick extends vscode.QuickPickItem {
  readonly entry?: McpCatalogServer;
}

function summary(entry: McpServerEntry): string {
  return entry.type === 'http' ? 'HTTP' : (entry.command ?? 'stdio');
}

function tooltipFor(entry: McpServerEntry, missing: readonly string[] = []): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendText(entry.name);
  const meta = entry.fakl;
  const field = (label: string, value?: string): void => {
    if (!value) return;
    tooltip.appendMarkdown(`\n\n**${label}:** `);
    tooltip.appendText(value);
  };
  if (meta?.descricao) {
    tooltip.appendMarkdown('\n\n');
    tooltip.appendText(meta.descricao);
  }
  field(l10n.t('Missing secret'), missing.join(', '));
  field(l10n.t('Category'), meta?.categoria);
  field(l10n.t('Read-only'), meta?.somenteLeitura);
  field(l10n.t('License'), meta?.licenca);
  field(l10n.t('Sources'), meta?.fontes?.join(', '));
  return tooltip;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Servidores MCP instalados na IDE (`~/.fakl/mcp.json`), entregues pelo Core a
 * todos os agentes. Os segredos ficam no SecretStorage e vão ao cofre do Core.
 */
export class McpLibraryView
  implements vscode.TreeDataProvider<InstalledMcpServer>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private entries: readonly InstalledMcpServer[] = [];
  private client: CoreClient | undefined;
  private file: string | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sources: ResourceSourcesView,
  ) {
    this.disposables.push(
      this.changed,
      vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this }),
      vscode.commands.registerCommand('fakl.resources.mcpLibrary.install', () => this.install()),
      vscode.commands.registerCommand('fakl.resources.mcpLibrary.refresh', () => this.refresh()),
      vscode.commands.registerCommand('fakl.resources.mcpLibrary.openFile', () => this.openFile()),
      vscode.commands.registerCommand(
        'fakl.resources.mcpLibrary.secrets',
        (entry?: InstalledMcpServer) => this.askSecrets(entry, true),
      ),
      vscode.commands.registerCommand(
        'fakl.resources.mcpLibrary.remove',
        (entry?: InstalledMcpServer) => this.remove(entry),
      ),
      // Outra janela da IDE guardou um segredo: o Core desta conexão também precisa dele.
      context.secrets.onDidChange((event) => {
        if (event.key.startsWith(SECRET_PREFIX)) {
          void this.pushSecret(event.key.slice(SECRET_PREFIX.length)).then(() => this.reload());
        }
      }),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    void this.pushAll().then(() => this.reload());
  }

  disconnected(): void {
    this.client = undefined;
    this.entries = [];
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.watcher?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  getTreeItem(entry: InstalledMcpServer): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.name);
    item.id = `mcp:${entry.name}`;
    const missing = entry.faltando.length > 0;
    item.description = missing ? l10n.t('secret missing') : summary(entry);
    item.iconPath = new vscode.ThemeIcon(missing ? 'warning' : 'server');
    item.contextValue = 'fakl.resource.mcpLibrary';
    item.tooltip = tooltipFor(entry, entry.faltando);
    if (missing) {
      item.command = {
        command: 'fakl.resources.mcpLibrary.secrets',
        title: l10n.t('Set secrets'),
        arguments: [entry],
      };
    }
    return item;
  }

  getChildren(entry?: InstalledMcpServer): InstalledMcpServer[] {
    return entry ? [] : [...this.entries];
  }

  private requireClient(): CoreClient | undefined {
    if (!this.client)
      void vscode.window.showWarningMessage(l10n.t('The FaKL Core is not responding.'));
    return this.client;
  }

  private storedIds(): string[] {
    return this.context.globalState.get<string[]>(INDEX_KEY, []);
  }

  private async pushSecret(id: string): Promise<void> {
    const value = await this.context.secrets.get(`${SECRET_PREFIX}${id}`);
    await this.client
      ?.request('secrets.set', { nome: mcpSecretName(id), valor: value ?? null })
      .catch(() => undefined);
  }

  private async pushAll(): Promise<void> {
    for (const id of this.storedIds()) await this.pushSecret(id);
  }

  private async refresh(): Promise<void> {
    if (!this.requireClient()) return;
    try {
      await this.reload(true);
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not read the MCP servers: {0}', errorText(error)),
      );
    }
  }

  private async reload(rethrow = false): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const info = await client.request<McpLibraryInfo>('mcps.list');
      if (client !== this.client) return;
      this.entries = info.servers;
      this.watch(info.arquivo);
      this.changed.fire(undefined);
    } catch (error) {
      if (rethrow) throw error;
    }
  }

  /** O arquivo pode ser editado à mão; a view acompanha. */
  private watch(file: string): void {
    if (file === this.file) return;
    this.watcher?.dispose();
    this.file = file;
    const uri = vscode.Uri.file(file);
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), 'mcp.json'),
    );
    const reload = (): void => {
      void this.reload();
    };
    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(reload);
  }

  private async install(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    try {
      const sources = await this.sources.reload();
      if (sources.length === 0) {
        await this.sources.offerAdd(l10n.t('No resource source added yet to install MCP servers.'));
        return;
      }
      const catalog = await client.request<McpCatalog>('mcps.catalog');
      const groups = groupOffered(catalog.servers, sources);
      if (!groups.length) {
        void vscode.window.showInformationMessage(
          catalog.servers.length
            ? l10n.t('All MCP servers from the sources are already installed.')
            : l10n.t('The added sources have no MCP servers (mcps.json).'),
        );
        return;
      }
      const items = groups.flatMap((group): CatalogPick[] => [
        { label: group.nome, kind: vscode.QuickPickItemKind.Separator },
        ...[...group.items]
          .sort(
            (a, b) =>
              RELEVANCE_ORDER[a.fakl?.relevancia ?? 'baixa'] -
                RELEVANCE_ORDER[b.fakl?.relevancia ?? 'baixa'] || a.name.localeCompare(b.name),
          )
          .map((entry): CatalogPick => {
            const tags = [
              entry.fakl?.categoria,
              entry.fakl?.oficial ? l10n.t('official') : l10n.t('community'),
              entry.inputs.length ? l10n.t('needs a secret') : undefined,
              entry.riscos.length > 0 ? riskSummary(entry.riscos) : undefined,
            ].filter(Boolean);
            return {
              label: entry.name,
              description: tags.join(' · '),
              ...(entry.fakl?.descricao ? { detail: entry.fakl.descricao } : {}),
              // Aviso da varredura estática: ícone e, no tooltip, o resumo dos achados.
              ...(entry.riscos.length > 0
                ? {
                    buttons: [
                      {
                        iconPath: new vscode.ThemeIcon(
                          worstRisk(entry.riscos) === 'baixa' ? 'info' : 'warning',
                        ),
                        tooltip: riskTooltip(entry.riscos),
                      },
                    ],
                  }
                : {}),
              entry,
            };
          }),
      ]);
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
        title: l10n.t('Install MCP servers from the sources'),
        placeHolder: l10n.t('Installed servers go to every agent in the IDE'),
      });
      const chosen = (picked ?? []).flatMap(({ entry }) => (entry ? [entry] : []));
      if (!chosen.length) return;
      const confirmation = riskConfirmation(
        chosen
          .filter((entry) => needsConfirmation(entry.riscos))
          .map((entry) => ({
            kind: 'mcp' as const,
            name: entry.name,
            fonte: entry.fonte,
            riscos: entry.riscos,
          })),
        sources,
      );
      if (confirmation) {
        const installAnyway = l10n.t('Install anyway');
        const choice = await vscode.window.showWarningMessage(
          confirmation.message,
          { modal: true, detail: confirmation.detail },
          installAnyway,
        );
        if (choice !== installAnyway) return;
      }
      let info: McpLibraryInfo | undefined;
      for (const [fonte, names] of namesBySource(chosen)) {
        info = await client.request<McpLibraryInfo>('mcps.install', { names, fonte });
      }
      if (!info) return;
      this.entries = info.servers;
      this.changed.fire(undefined);
      for (const entry of chosen) {
        const installed = info.servers.find((server) => server.name === entry.name);
        if (installed?.faltando.length) await this.askSecrets(installed, false);
      }
      await this.reload();
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not install the MCP servers: {0}', errorText(error)),
      );
    }
  }

  /** Pede os segredos do servidor; `all` pede de novo também os já guardados. */
  private async askSecrets(entry: InstalledMcpServer | undefined, all: boolean): Promise<void> {
    if (!entry || !this.requireClient()) return;
    const inputs: readonly McpInputSpec[] = all
      ? entry.inputs
      : entry.inputs.filter((input) => entry.faltando.includes(input.id));
    if (!inputs.length) {
      void vscode.window.showInformationMessage(l10n.t('{0} uses no secrets.', entry.name));
      return;
    }
    for (const input of inputs) {
      const value = await vscode.window.showInputBox({
        title: l10n.t('MCP server {0}', entry.name),
        prompt: input.description,
        password: input.password ?? true,
        ignoreFocusOut: true,
        placeHolder: l10n.t('Stored in the system keychain; Esc to skip'),
      });
      if (value === undefined) continue;
      if (!value.trim()) continue;
      await this.context.secrets.store(`${SECRET_PREFIX}${input.id}`, value.trim());
      const ids = new Set(this.storedIds());
      ids.add(input.id);
      await this.context.globalState.update(INDEX_KEY, [...ids].sort());
      await this.pushSecret(input.id);
    }
    await this.reload();
  }

  private async remove(entry?: InstalledMcpServer): Promise<void> {
    const client = this.requireClient();
    if (!entry || !client) return;
    const removeLabel = l10n.t('Remove');
    const choice = await vscode.window.showWarningMessage(
      l10n.t(
        'Remove the MCP server {0} from the IDE? Agents stop receiving it in their next sessions.',
        entry.name,
      ),
      { modal: true },
      removeLabel,
    );
    if (choice !== removeLabel) return;
    try {
      await client.request('mcps.remove', { name: entry.name });
      await this.reload();
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not remove {0}: {1}', entry.name, errorText(error)),
      );
    }
  }

  private async openFile(): Promise<void> {
    if (!this.requireClient()) return;
    await this.reload();
    if (!this.file) return;
    const uri = vscode.Uri.file(this.file);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from('{\n  "inputs": [],\n  "servers": {}\n}\n', 'utf8'),
      );
    }
    await vscode.window.showTextDocument(uri);
  }
}
