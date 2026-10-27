import { closeSync, openSync, readSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { CoreClient, PlaybookInfo, SearchHit, VaultStatus } from '@fakl/core';
import { currentLocale, l10n } from '@fakl/i18n';
import type { Run, Task } from '@fakl/protocol';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import { EmbeddingsUi } from './vault-embeddings.js';
import type { EmbedNote } from './vault-embed.js';
import { VaultNotesUi } from './vault-tree.js';
import { newNotePath, type FolderNode } from './vault-tree-model.js';

interface GraphNode {
  path: string;
  title: string;
}

interface Backlink {
  path: string;
  title: string;
}

const SEARCH_DELAY_MS = 150;
/** Quanto de uma nota a prévia lê para incorporá-la; o resto seria cortado de qualquer jeito. */
const EMBED_READ_BYTES = 64 * 1024;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * O vault na IDE (SDD 10, RF-401 a RF-404): barra de status, busca, nota
 * diária, backlinks da nota aberta, playbooks e a resolução de wikilinks da
 * prévia de Markdown. Tudo passa pelo Core, que dono do índice.
 */
export class VaultUi implements vscode.TreeDataProvider<Backlink>, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly item: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly notesChanged = new vscode.EventEmitter<void>();
  private readonly backlinksView: vscode.TreeView<Backlink>;
  private client: CoreClient | undefined;
  private status: VaultStatus | undefined;
  private syncing = false;
  /** Nome da nota (sem .md, minúsculo) e caminho relativo → caminho relativo. */
  private names = new Map<string, string>();
  /** Caminhos de todas as notas do vault, para o explorador da barra lateral. */
  private notePaths: string[] = [];
  private backlinks: Backlink[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  private readonly embeddings: EmbeddingsUi;

  constructor(router: AgentEventRouter, context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem('fakl.vault', vscode.StatusBarAlignment.Left, 99);
    this.item.name = l10n.t('FaKL vault');
    this.item.command = 'fakl.vault.menu';
    this.backlinksView = vscode.window.createTreeView('fakl.vault.backlinks', {
      treeDataProvider: this,
    });
    this.embeddings = new EmbeddingsUi(context, {
      client: () => this.client,
      status: () => this.status,
      reload: () => this.reload(),
    });
    this.disposables.push(
      this.item,
      this.embeddings,
      this.changed,
      this.notesChanged,
      this.backlinksView,
      new VaultNotesUi(
        () => this.root,
        () => this.notePaths,
        this.notesChanged.event,
      ),
      router.listen((event) => {
        if (event.topic === 'vault.sync') {
          const data = event.data as { fase?: string; conflicts?: string[]; error?: string };
          this.syncing = data.fase === 'inicio';
          if (data.fase === 'fim') {
            if (data.conflicts?.length) void this.warnConflicts(data.conflicts);
            void this.reload();
          } else {
            this.render();
          }
        } else if (event.topic === 'config.changed') {
          void this.reload();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => void this.updateBacklinks()),
      vscode.commands.registerCommand('fakl.vault.menu', () => this.menu()),
      vscode.commands.registerCommand('fakl.vault.configure', () => this.configure()),
      vscode.commands.registerCommand('fakl.vault.search', () => this.search(false)),
      vscode.commands.registerCommand('fakl.vault.semanticSearch', () => this.search(true)),
      vscode.commands.registerCommand('fakl.vault.daily', () => this.daily()),
      vscode.commands.registerCommand('fakl.vault.appendDaily', () => this.appendDaily()),
      vscode.commands.registerCommand('fakl.vault.newNote', () => this.newNote()),
      vscode.commands.registerCommand('fakl.vault.newNoteHere', (folder?: FolderNode) =>
        this.newNote(folder?.path),
      ),
      vscode.commands.registerCommand('fakl.vault.sync', () => this.sync()),
      vscode.commands.registerCommand('fakl.vault.openWindow', () => this.openWindow()),
      vscode.commands.registerCommand('fakl.vault.openNote', (path: string) => this.open(path)),
      vscode.commands.registerCommand('fakl.playbooks.run', () => this.runPlaybook()),
      vscode.commands.registerCommand('fakl.tasks.fromNote', () => this.taskFromNote()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    // A chave vai antes: o Core indexa assim que o vault abre.
    void this.embeddings.connected(client).then(() => this.reload());
  }

  disconnected(): void {
    this.client = undefined;
    this.status = undefined;
    this.notePaths = [];
    this.notesChanged.fire();
    this.render();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.watcher?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  get root(): string | undefined {
    return this.status?.ativo ? this.status.caminho : undefined;
  }

  // ---------------------------------------------------------------- estado

  private async reload(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      this.status = await client.request<VaultStatus>('vault.status');
    } catch {
      this.status = undefined;
    }
    void vscode.commands.executeCommand('setContext', 'fakl.vault.active', this.root !== undefined);
    this.watch();
    await this.refreshNames();
    this.render();
    await this.updateBacklinks();
  }

  /** Observa a pasta do vault para a prévia achar notas novas. */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const root = this.root;
    if (!root) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), '**/*.md'),
    );
    const later = (): void => {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        void this.refreshNames().then(() => this.updateBacklinks());
      }, 500);
    };
    this.watcher.onDidCreate(later);
    this.watcher.onDidDelete(later);
    this.watcher.onDidChange(later);
  }

  private async refreshNames(): Promise<void> {
    const names = new Map<string, string>();
    let paths: string[] = [];
    if (this.client && this.root) {
      const graph = await this.client
        .request<{ nodes: GraphNode[] }>('vault.graph')
        .catch(() => ({ nodes: [] }));
      paths = graph.nodes.map((node) => node.path);
      // Caminhos mais curtos primeiro: como no Obsidian, vencem nomes repetidos.
      const nodes = [...graph.nodes].sort((a, b) => a.path.length - b.path.length);
      for (const node of nodes) {
        const withoutExt = node.path.replace(/\.md$/i, '').toLowerCase();
        names.set(withoutExt, node.path);
        names.set(node.path.toLowerCase(), node.path);
        const base = withoutExt.split('/').pop() ?? withoutExt;
        if (!names.has(base)) names.set(base, node.path);
      }
    }
    this.names = names;
    this.notePaths = paths;
    this.notesChanged.fire();
  }

  private render(): void {
    const status = this.status;
    if (!this.client) {
      this.item.hide();
      return;
    }
    if (!status?.ativo) {
      this.item.text = '$(book) Vault';
      this.item.tooltip = l10n.t('No vault set up. Click to choose the folder.');
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    const icon = this.syncing ? '$(sync~spin)' : status.ultimoErro ? '$(warning)' : '$(book)';
    this.item.text = `${icon} Vault`;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`${l10n.t('**Vault** at `{0}`', status.caminho ?? '')}\n\n`);
    tooltip.appendMarkdown(
      `${status.notas === 1 ? l10n.t('1 note') : l10n.t('{0} notes', String(status.notas))}\n\n`,
    );
    if (!status.sincroniza) {
      tooltip.appendMarkdown(`${l10n.t('No sync (no origin remote)')}\n\n`);
    }
    if (status.ultimaSincronizacao) {
      const when = new Date(status.ultimaSincronizacao).toLocaleTimeString(currentLocale());
      tooltip.appendMarkdown(`${l10n.t('Last sync: {0}', when)}\n\n`);
    }
    if (status.ultimoErro) tooltip.appendMarkdown(`${l10n.t('Error: {0}', status.ultimoErro)}\n\n`);
    if (status.conflitos.length > 0) {
      tooltip.appendMarkdown(l10n.t('Saved conflicts: {0}', status.conflitos.join(', ')));
    }
    this.item.tooltip = tooltip;
    this.item.backgroundColor = status.ultimoErro
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  private async warnConflicts(files: readonly string[]): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      l10n.t(
        'The vault had changes on both machines in {0}. The remote version was kept; yours is next to it, as "(conflito …)".',
        files.join(', '),
      ),
      l10n.t('Open'),
    );
    if (choice && files[0]) await this.open(files[0]);
  }

  // ---------------------------------------------------------------- prévia

  /** Href de um wikilink para a prévia, relativo ao documento aberto. */
  resolveLink(target: string, env: unknown): string | undefined {
    const root = this.root;
    if (!root) return undefined;
    const path = this.notePath(target);
    if (!path) return undefined;
    const absolute = join(root, path);
    const current = (env as { currentDocument?: vscode.Uri } | undefined)?.currentDocument;
    const from = current?.scheme === 'file' ? dirname(current.fsPath) : root;
    return encodeURI(toPosix(relative(from, absolute)));
  }

  /** Caminho no vault da nota que um wikilink aponta, ou `undefined`. */
  private notePath(target: string): string | undefined {
    const key = target.replace(/\\/g, '/').toLowerCase();
    return this.names.get(key) ?? this.names.get(key.replace(/\.md$/, ''));
  }

  /**
   * Texto de uma nota para o embed `![[nota]]` da prévia. Síncrono porque o
   * markdown-it é; lê no máximo `EMBED_READ_BYTES`, já que a prévia corta antes.
   */
  readNote(target: string): EmbedNote | undefined {
    const root = this.root;
    const path = this.notePath(target);
    if (!root || !path) return undefined;
    let fd: number | undefined;
    try {
      fd = openSync(join(root, path), 'r');
      const buffer = Buffer.alloc(EMBED_READ_BYTES);
      const read = readSync(fd, buffer, 0, EMBED_READ_BYTES, 0);
      return { key: path, text: buffer.toString('utf8', 0, read) };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Caminho no vault do documento aberto na prévia, para detectar a nota que se embute. */
  currentNoteKey(env: unknown): string | undefined {
    const root = this.root;
    const current = (env as { currentDocument?: vscode.Uri } | undefined)?.currentDocument;
    if (!root || current?.scheme !== 'file') return undefined;
    const rel = relative(root, current.fsPath);
    return !rel || rel.startsWith('..') || isAbsolute(rel) ? undefined : toPosix(rel);
  }

  // ---------------------------------------------------------------- backlinks

  private relativeOf(uri: vscode.Uri | undefined): string | undefined {
    const root = this.root;
    if (!root || uri?.scheme !== 'file') return undefined;
    const rel = relative(root, uri.fsPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return toPosix(rel);
  }

  private async updateBacklinks(): Promise<void> {
    const path = this.relativeOf(vscode.window.activeTextEditor?.document.uri);
    if (!path?.toLowerCase().endsWith('.md') || !this.client) {
      if (!path) {
        this.backlinks = [];
        this.backlinksView.description = '';
        this.backlinksView.message = this.root
          ? l10n.t('Open a vault note to see what links to it.')
          : l10n.t('Set up a vault to see backlinks.');
        this.changed.fire(undefined);
      }
      return;
    }
    this.backlinks = await this.client
      .request<Backlink[]>('vault.backlinks', { path })
      .catch(() => []);
    this.backlinksView.description = (path.split('/').pop() ?? path).replace(/\.md$/i, '');
    this.backlinksView.message =
      this.backlinks.length === 0 ? l10n.t('No notes link to this one.') : '';
    this.changed.fire(undefined);
  }

  getTreeItem(link: Backlink): vscode.TreeItem {
    const item = new vscode.TreeItem(link.title);
    if (link.path.includes('/')) item.description = dirname(link.path);
    item.tooltip = link.path;
    item.command = {
      command: 'fakl.vault.openNote',
      title: l10n.t('Open'),
      arguments: [link.path],
    };
    return item;
  }

  getChildren(): Backlink[] {
    return this.backlinks;
  }

  // ---------------------------------------------------------------- comandos

  private requireClient(): CoreClient | undefined {
    if (!this.client) void vscode.window.showWarningMessage(l10n.t('FaKL Core is not responding.'));
    return this.client;
  }

  private async requireVault(): Promise<string | undefined> {
    if (this.root) return this.root;
    const choice = await vscode.window.showInformationMessage(
      l10n.t('No vault set up yet.'),
      l10n.t('Choose folder'),
    );
    if (choice) await this.configure();
    return this.root;
  }

  private async open(path: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    await vscode.window.showTextDocument(vscode.Uri.file(join(root, path)));
  }

  private async menu(): Promise<void> {
    const actions: (vscode.QuickPickItem & { command?: string })[] = this.root
      ? [
          { label: `$(search) ${l10n.t('Search the vault')}`, command: 'fakl.vault.search' },
          ...(this.status?.semantica?.aguardaConfirmacao
            ? [
                {
                  label: `$(shield) ${l10n.t('Confirm sending notes to the embeddings API')}`,
                  command: 'fakl.vault.embeddings.confirm',
                },
              ]
            : []),
          ...(this.status?.semantica
            ? [
                {
                  label: `$(sparkle) ${l10n.t('Semantic search')}`,
                  command: 'fakl.vault.semanticSearch',
                },
              ]
            : []),
          { label: `$(type-hierarchy) ${l10n.t('Vault graph')}`, command: 'fakl.vault.graph' },
          { label: `$(calendar) ${l10n.t("Today's note")}`, command: 'fakl.vault.daily' },
          { label: `$(add) ${l10n.t('New note')}`, command: 'fakl.vault.newNote' },
          { label: `$(note) ${l10n.t('Add to daily note')}`, command: 'fakl.vault.appendDaily' },
          { label: `$(play) ${l10n.t('Run playbook')}`, command: 'fakl.playbooks.run' },
          { label: `$(sync) ${l10n.t('Sync now')}`, command: 'fakl.vault.sync' },
          {
            label: `$(window) ${l10n.t('Open the vault in a window')}`,
            command: 'fakl.vault.openWindow',
          },
          {
            label: `$(sparkle) ${l10n.t('Semantic search: choose the embeddings provider')}`,
            command: 'fakl.vault.embeddings.configure',
          },
          {
            label: `$(gear) ${l10n.t('Change folder or remote')}`,
            command: 'fakl.vault.configure',
          },
        ]
      : [
          {
            label: `$(folder-opened) ${l10n.t('Choose the vault folder')}`,
            command: 'fakl.vault.configure',
          },
        ];
    const picked = await vscode.window.showQuickPick(actions, { title: 'Vault' });
    if (picked?.command) await vscode.commands.executeCommand(picked.command);
  }

  private async configure(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const options: (vscode.QuickPickItem & { id: string })[] = [
      {
        id: 'pasta',
        label: `$(folder-opened) ${l10n.t('Choose folder')}`,
        detail: l10n.t('An existing or empty folder, like an Obsidian one'),
      },
      {
        id: 'clonar',
        label: `$(repo-clone) ${l10n.t('Clone from a private git repository')}`,
        detail: l10n.t('For the second machine: the vault comes from GitHub'),
      },
      ...(this.root
        ? [{ id: 'desligar', label: `$(circle-slash) ${l10n.t('Turn off the vault')}` }]
        : []),
    ];
    const choice = await vscode.window.showQuickPick(options, {
      title: l10n.t('Set up the vault'),
    });
    if (!choice) return;
    try {
      if (choice.id === 'desligar') {
        await client.request('vault.configure', { caminho: null });
      } else if (choice.id === 'pasta') {
        const folder = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: l10n.t('Use as vault'),
        });
        if (!folder?.[0]) return;
        await client.request('vault.configure', { caminho: folder[0].fsPath });
      } else {
        const remoto = await vscode.window.showInputBox({
          title: l10n.t('Vault repository'),
          prompt: l10n.t('URL of the private git repository (https or ssh)'),
          placeHolder: 'git@github.com:voce/vault.git',
          ignoreFocusOut: true,
        });
        if (!remoto) return;
        const parent = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: l10n.t('Clone in here'),
        });
        if (!parent?.[0]) return;
        const name =
          remoto
            .replace(/\.git$/, '')
            .split(/[/:]/)
            .pop() ?? 'Vault';
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: l10n.t('Cloning the vault…') },
          () =>
            client.request('vault.configure', {
              caminho: join(parent[0]?.fsPath ?? '', name),
              remoto,
            }),
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t("Couldn't set up the vault: {0}", message(error)));
      return;
    }
    await this.reload();
    if (this.status?.ultimoErro) {
      void vscode.window.showWarningMessage(
        l10n.t('Vault opened with a warning: {0}', this.status.ultimoErro),
      );
    } else if (this.root) {
      const notas = this.status?.notas ?? 0;
      void vscode.window.showInformationMessage(
        notas === 1
          ? l10n.t('Vault at {0} with 1 note.', this.root)
          : l10n.t('Vault at {0} with {1} notes.', this.root, String(notas)),
      );
    }
  }

  /** API de embeddings configurada, mas sem o "sim" da pessoa ao envio das notas. */
  private awaitingConfirmation(): boolean {
    return this.status?.semantica?.aguardaConfirmacao === true;
  }

  private async search(semantic: boolean): Promise<void> {
    const client = this.requireClient();
    if (!client || !(await this.requireVault())) return;
    if (semantic && this.awaitingConfirmation()) {
      await vscode.commands.executeCommand('fakl.vault.embeddings.confirm');
      if (this.awaitingConfirmation()) return;
    }
    if (semantic && !this.status?.semantica) {
      const choice = await vscode.window.showInformationMessage(
        l10n.t(
          'Semantic search is off. Choose an embeddings provider: a local model (e.g. nomic-embed-text on Ollama) or an OpenAI-compatible API.',
        ),
        l10n.t('Choose the provider'),
      );
      if (choice) await vscode.commands.executeCommand('fakl.vault.embeddings.configure');
      return;
    }
    const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { path: string }>();
    pick.title = semantic ? l10n.t('Semantic search in the vault') : l10n.t('Search the vault');
    pick.placeholder = semantic
      ? l10n.t("Describe what you're looking for, in your own words")
      : l10n.t('Words, tag:projeto, #ideia or pasta:Projetos');
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    let timer: NodeJS.Timeout | undefined;
    let generation = 0;
    const run = (query: string): void => {
      clearTimeout(timer);
      const current = ++generation;
      timer = setTimeout(
        () => {
          if (!query.trim()) {
            pick.items = [];
            return;
          }
          pick.busy = true;
          void client
            .request<SearchHit[]>(semantic ? 'vault.semanticSearch' : 'vault.search', {
              consulta: query,
              limite: semantic ? 20 : 50,
            })
            .then((hits) => {
              if (current !== generation) return;
              pick.items = hits.map((hit) => ({
                label: hit.title,
                description: hit.path,
                detail: hit.snippet,
                path: hit.path,
                alwaysShow: true,
              }));
            })
            .catch((error: unknown) => {
              pick.items = [];
              pick.placeholder = message(error);
            })
            .finally(() => {
              if (current === generation) pick.busy = false;
            });
        },
        semantic ? SEARCH_DELAY_MS * 3 : SEARCH_DELAY_MS,
      );
    };
    pick.onDidChangeValue(run);
    pick.onDidAccept(() => {
      const chosen = pick.selectedItems[0];
      pick.hide();
      if (chosen) void this.open(chosen.path);
    });
    pick.onDidHide(() => {
      clearTimeout(timer);
      pick.dispose();
    });
    pick.show();
  }

  private async daily(): Promise<void> {
    const client = this.requireClient();
    if (!client || !(await this.requireVault())) return;
    const { path } = await client.request<{ path: string }>('vault.daily');
    await this.open(path);
  }

  private async appendDaily(): Promise<void> {
    const client = this.requireClient();
    if (!client || !(await this.requireVault())) return;
    const texto = await vscode.window.showInputBox({
      title: l10n.t('Add to daily note'),
      prompt: l10n.t("Becomes a timestamped line in today's note"),
    });
    if (!texto) return;
    await client.request('vault.appendDaily', { texto });
  }

  /** Cria uma nota; `folder` vem do menu de uma pasta do explorador, senão vai para a Inbox. */
  private async newNote(folder?: string): Promise<void> {
    const client = this.requireClient();
    if (!client || !(await this.requireVault())) return;
    const titulo = await vscode.window.showInputBox({
      title: l10n.t('New note'),
      prompt: folder
        ? l10n.t('Title of the new note in {0}', folder)
        : l10n.t('Title; use Folder/Title to create it outside the Inbox'),
    });
    if (!titulo?.trim()) return;
    const path = newNotePath(titulo, folder);
    const name = path.split('/').pop() ?? titulo.trim();
    const existing = this.names.get(path.toLowerCase());
    if (existing) {
      await this.open(existing);
      return;
    }
    const created = await client.request<{ path: string }>('vault.write', {
      caminho: path,
      conteudo: `# ${name}\n\n`,
    });
    await this.open(created.path);
  }

  private async sync(): Promise<void> {
    const client = this.requireClient();
    if (!client || !(await this.requireVault())) return;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: l10n.t('Syncing the vault') },
      () =>
        client.request<{ ok: boolean; changed: boolean; conflicts: string[]; error?: string }>(
          'vault.sync',
        ),
    );
    if (!result.ok) {
      void vscode.window.showWarningMessage(
        l10n.t("The vault didn't sync: {0}", result.error ?? l10n.t('error')),
      );
    } else if (result.conflicts.length === 0) {
      vscode.window.setStatusBarMessage(
        `$(check) ${result.changed ? l10n.t('Vault synced') : l10n.t('Vault was already up to date')}`,
        4_000,
      );
    }
  }

  private async openWindow(): Promise<void> {
    const root = await this.requireVault();
    if (root) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), {
        forceNewWindow: true,
      });
    }
  }

  // ---------------------------------------------------------------- tarefas

  private async pickRepo(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) return folders[0]?.uri.fsPath;
    if (folders.length > 1) {
      const folder = await vscode.window.showWorkspaceFolderPick({
        placeHolder: l10n.t('In which repository?'),
      });
      return folder?.uri.fsPath;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: l10n.t('Use this repository'),
    });
    return picked?.[0]?.fsPath;
  }

  private async started(task: Task, run?: Run): Promise<void> {
    await vscode.commands.executeCommand('fakl.tasks.refresh');
    const choice = await vscode.window.showInformationMessage(
      run ? l10n.t('Task "{0}" started.', task.titulo) : l10n.t('Task "{0}" created.', task.titulo),
      l10n.t('View tasks'),
    );
    if (choice) await vscode.commands.executeCommand('fakl.tasks.focus');
  }

  private async runPlaybook(): Promise<void> {
    const client = this.requireClient();
    if (!client || !(await this.requireVault())) return;
    const playbooks = await client.request<PlaybookInfo[]>('playbooks.list');
    if (playbooks.length === 0) {
      void vscode.window.showInformationMessage(
        l10n.t(
          'No playbooks yet. Create a note in Playbooks/ with "tipo: playbook" in the frontmatter.',
        ),
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      playbooks.map((playbook) => ({
        label: playbook.nome,
        description: [playbook.maestro, playbook.entrega].filter(Boolean).join(' · '),
        detail: playbook.instrucoes.split('\n')[0] ?? '',
        playbook,
      })),
      { title: l10n.t('Run playbook') },
    );
    if (!picked) return;
    const repoPath = await this.pickRepo();
    if (!repoPath) return;
    const objetivo = await vscode.window.showInputBox({
      title: picked.playbook.nome,
      prompt: l10n.t('Anything extra for this time? (optional)'),
      ignoreFocusOut: true,
    });
    if (objetivo === undefined) return;
    try {
      const result = await client.request<{ task: Task; run: Run }>('playbooks.run', {
        nome: picked.playbook.nome,
        repoPath,
        ...(objetivo ? { objetivo } : {}),
        origem: 'manual',
      });
      await this.started(result.task, result.run);
    } catch (error) {
      void vscode.window.showErrorMessage(l10n.t("The playbook didn't start: {0}", message(error)));
    }
  }

  private async taskFromNote(): Promise<void> {
    const client = this.requireClient();
    if (!client) return;
    const document = vscode.window.activeTextEditor?.document;
    const path = this.relativeOf(document?.uri);
    if (!document || !path) {
      void vscode.window.showInformationMessage(
        l10n.t('Open a vault note to turn it into a task.'),
      );
      return;
    }
    if (document.isDirty) await document.save();
    const text = await readFile(document.uri.fsPath, 'utf8').catch(() => document.getText());
    const hasRepo = /^---[\s\S]*?^repo:\s*\S/m.test(text);
    const repoPath = hasRepo ? undefined : await this.pickRepo();
    if (!hasRepo && !repoPath) return;
    try {
      const result = await client.request<{ task: Task; run?: Run }>('tasks.fromNote', {
        path,
        ...(repoPath ? { repoPath } : {}),
        comecar: true,
      });
      await this.started(result.task, result.run);
    } catch (error) {
      void vscode.window.showErrorMessage(
        l10n.t("The note didn't become a task: {0}", message(error)),
      );
    }
  }
}
