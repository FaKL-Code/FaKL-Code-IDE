import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

interface McpEntry {
  readonly kind: 'mcp';
  readonly name: string;
  readonly uri: vscode.Uri;
  readonly description?: string;
  /** Marca o item que só aponta um mcp.json ilegível: abrir sim, remover não. */
  readonly invalid?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isFile(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Servidores MCP definidos pelo workspace em `.vscode/mcp.json`. */
export class McpResourcesView implements vscode.TreeDataProvider<McpEntry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeTreeData = this.changed.event;

  constructor() {
    this.disposables.push(
      this.changed,
      vscode.window.createTreeView('fakl.resources.mcps', { treeDataProvider: this }),
      vscode.commands.registerCommand('fakl.resources.mcps.create', () => this.create()),
      vscode.commands.registerCommand('fakl.resources.mcps.open', (entry?: McpEntry) =>
        this.open(entry),
      ),
      vscode.commands.registerCommand('fakl.resources.mcps.remove', (entry?: McpEntry) =>
        this.remove(entry),
      ),
      vscode.commands.registerCommand('fakl.resources.mcps.refresh', () => {
        this.changed.fire(undefined);
      }),
    );
    const watcher = vscode.workspace.createFileSystemWatcher('.vscode/mcp.json');
    watcher.onDidCreate(() => {
      this.changed.fire(undefined);
    });
    watcher.onDidChange(() => {
      this.changed.fire(undefined);
    });
    watcher.onDidDelete(() => {
      this.changed.fire(undefined);
    });
    this.disposables.push(watcher);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  getTreeItem(entry: McpEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.name);
    if (entry.description) item.description = entry.description;
    item.tooltip = entry.uri.fsPath;
    item.contextValue = entry.invalid ? 'fakl.resource.mcp.invalid' : 'fakl.resource.mcp';
    item.iconPath = new vscode.ThemeIcon('server');
    item.command = {
      command: 'fakl.resources.mcps.open',
      title: l10n.t('Open'),
      arguments: [entry],
    };
    return item;
  }

  async getChildren(entry?: McpEntry): Promise<McpEntry[]> {
    if (entry) return [];
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];
    const file = vscode.Uri.joinPath(folder.uri, '.vscode', 'mcp.json');
    if (!(await isFile(file))) return [];
    try {
      const parsed = JSON.parse(
        Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'),
      ) as { servers?: Record<string, { command?: string; url?: string; type?: string }> };
      return Object.entries(parsed.servers ?? {}).map(([name, server]) => ({
        kind: 'mcp',
        name,
        description: server.type === 'http' || server.url ? 'HTTP' : (server.command ?? 'stdio'),
        uri: file,
      }));
    } catch {
      return [
        {
          kind: 'mcp',
          name: l10n.t('invalid mcp.json — open to fix'),
          uri: file,
          invalid: true,
        },
      ];
    }
  }

  private workspace(): vscode.WorkspaceFolder | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(l10n.t('Open a project folder to manage MCP servers.'));
    }
    return folder;
  }

  private async create(): Promise<void> {
    const folder = this.workspace();
    if (!folder) return;
    const name = await vscode.window.showInputBox({
      title: l10n.t('Add MCP server'),
      prompt: l10n.t('Server name'),
      validateInput: (value) => (value.trim() ? undefined : l10n.t('Enter a name.')),
    });
    if (!name) return;
    const command = await vscode.window.showInputBox({
      title: l10n.t('Add MCP server'),
      prompt: l10n.t('Executable command (for example: npx)'),
      value: 'npx',
      validateInput: (value) => (value.trim() ? undefined : l10n.t('Enter the command.')),
    });
    if (!command) return;
    const argsText = await vscode.window.showInputBox({
      title: l10n.t('Add MCP server'),
      prompt: l10n.t('Arguments as a JSON list (optional)'),
      value: '["-y", "@modelcontextprotocol/server-filesystem", "."]',
    });
    let args: string[] = [];
    if (argsText?.trim()) {
      try {
        const parsed: unknown = JSON.parse(argsText);
        if (!Array.isArray(parsed) || !parsed.every((arg: unknown) => typeof arg === 'string')) {
          throw new Error(l10n.t('the arguments must be a list of strings'));
        }
        args = parsed;
      } catch (error) {
        void vscode.window.showErrorMessage(l10n.t('Invalid MCP arguments: {0}', errorText(error)));
        return;
      }
    }
    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'mcp.json');
    const key = name.trim();
    try {
      const config = await this.readConfig(uri);
      if (Object.hasOwn(config.servers, key)) {
        void vscode.window.showWarningMessage(l10n.t('The MCP server {0} already exists.', key));
        return;
      }
      config.servers[key] = { type: 'stdio', command: command.trim(), args };
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not add the MCP server: {0}', errorText(error)),
      );
      return;
    }
    await this.open({ kind: 'mcp', name: key, uri });
    this.changed.fire(undefined);
  }

  private async readConfig(
    uri: vscode.Uri,
  ): Promise<Record<string, unknown> & { servers: Record<string, unknown> }> {
    let config: Record<string, unknown> = {};
    if (await isFile(uri)) {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
        );
        if (!isRecord(parsed)) throw new Error(l10n.t('the configuration must be an object'));
        config = parsed;
      } catch (error) {
        throw new Error(l10n.t('Could not read .vscode/mcp.json: {0}', String(error)), {
          cause: error,
        });
      }
    }
    const servers = config.servers ?? {};
    if (!isRecord(servers)) throw new Error(l10n.t('.vscode/mcp.json: servers must be an object.'));
    return { ...config, servers };
  }

  private async open(entry?: McpEntry): Promise<void> {
    if (!entry) return;
    await vscode.window.showTextDocument(entry.uri);
  }

  private async remove(entry?: McpEntry): Promise<void> {
    if (!entry) return;
    const removeLabel = l10n.t('Remove');
    const choice = await vscode.window.showWarningMessage(
      l10n.t(
        'Remove {0} from this workspace? Git will record the change along with the project.',
        entry.name,
      ),
      { modal: true },
      removeLabel,
    );
    if (choice !== removeLabel) return;
    try {
      const config = await this.readConfig(entry.uri);
      const servers = Object.fromEntries(
        Object.entries(config.servers).filter(([name]) => name !== entry.name),
      );
      await vscode.workspace.fs.writeFile(
        entry.uri,
        Buffer.from(`${JSON.stringify({ ...config, servers }, null, 2)}\n`, 'utf8'),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t('Could not remove {0}: {1}', entry.name, errorText(error)),
      );
      return;
    }
    this.changed.fire(undefined);
  }
}
