import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { CoreClient, SearchHit } from '@fakl/core';
import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

import type { AgentEventRouter } from './agents.js';
import { fillTemplate } from './templates.js';
import type { GraphFromWebview, GraphToWebview, VaultGraphData } from './vault-graph-protocol.js';
import { attachTips } from './tour.js';
import type { FromTips } from './tour-protocol.js';

/** Tag ou nota com a tag, na árvore de tags. */
type TagItem =
  | { readonly kind: 'tag'; readonly tag: string; readonly count: number }
  | { readonly kind: 'note'; readonly path: string; readonly title: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Grafo, tags e templates do vault (RF-403): o grafo de notas e links num
 * painel, a árvore de tags na barra do vault e "Inserir template" no editor.
 */
export class VaultGraphUi implements vscode.TreeDataProvider<TagItem>, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<undefined>();
  private client: CoreClient | undefined;
  private panel: vscode.WebviewPanel | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly root: () => string | undefined,
    router: AgentEventRouter,
  ) {
    this.disposables.push(
      this.changed,
      vscode.window.createTreeView('fakl.vault.tags', { treeDataProvider: this }),
      router.listen((event) => {
        if (event.topic === 'vault.sync') this.refresh();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.postCurrent();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const root = this.root();
        if (root && document.uri.fsPath.startsWith(root)) this.refresh();
      }),
      vscode.commands.registerCommand('fakl.vault.graph', () => {
        this.showGraph();
      }),
      vscode.commands.registerCommand('fakl.vault.tags.refresh', () => {
        this.refresh();
      }),
      vscode.commands.registerCommand('fakl.vault.insertTemplate', () => this.insertTemplate()),
    );
  }

  connected(client: CoreClient): void {
    this.client = client;
    this.refresh();
  }

  disconnected(): void {
    this.client = undefined;
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private refresh(): void {
    this.changed.fire(undefined);
    if (this.panel) void this.postGraph();
  }

  // ---------------------------------------------------------------- tags

  getTreeItem(item: TagItem): vscode.TreeItem {
    if (item.kind === 'tag') {
      const tree = new vscode.TreeItem(`#${item.tag}`, vscode.TreeItemCollapsibleState.Collapsed);
      tree.description = String(item.count);
      tree.contextValue = 'tag';
      return tree;
    }
    const tree = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    tree.description = item.path;
    tree.command = {
      command: 'fakl.vault.openNote',
      title: l10n.t('Open'),
      arguments: [item.path],
    };
    return tree;
  }

  async getChildren(item?: TagItem): Promise<TagItem[]> {
    const client = this.client;
    if (!client || !this.root()) return [];
    try {
      if (!item) {
        const tags = await client.request<Record<string, number>>('vault.tags');
        return Object.entries(tags)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([tag, count]) => ({ kind: 'tag', tag, count }));
      }
      if (item.kind !== 'tag') return [];
      const hits = await client.request<SearchHit[]>('vault.search', {
        query: `tag:${item.tag}`,
        limite: 100,
      });
      return hits
        .filter((hit) => hit.tags.includes(item.tag))
        .map((hit) => ({ kind: 'note', path: hit.path, title: hit.title }));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- grafo

  private showGraph(): void {
    if (!this.root()) {
      void vscode.window.showInformationMessage(l10n.t('Set up the vault first.'));
      return;
    }
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'dist', 'graph');
    const panel = vscode.window.createWebviewPanel(
      'fakl.vault.graph',
      l10n.t('Vault graph'),
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [media] },
    );
    this.panel = panel;
    panel.webview.html = this.html(panel.webview, media);
    attachTips(panel, 'vault');
    panel.webview.onDidReceiveMessage((message: GraphFromWebview | FromTips) => {
      if (message.type === 'ready') void this.postGraph();
      else if (message.type === 'open') {
        void vscode.commands.executeCommand('fakl.vault.openNote', message.path);
      }
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private currentNote(): string | undefined {
    const root = this.root();
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!root || !file?.startsWith(root)) return undefined;
    return file
      .slice(root.length + 1)
      .split('\\')
      .join('/');
  }

  private postCurrent(): void {
    const current = this.currentNote();
    if (current) this.post({ type: 'current', path: current });
  }

  private async postGraph(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const graph = await client.request<VaultGraphData>('vault.graph');
      const current = this.currentNote();
      this.post({ type: 'graph', graph, ...(current ? { current } : {}) });
    } catch (error) {
      void vscode.window.showWarningMessage(l10n.t("Couldn't read the graph: {0}", message(error)));
    }
  }

  private post(message: GraphToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="${vscode.env.language}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  canvas { display: block; width: 100vw; height: 100vh; }
  #filtro { position: absolute; top: 10px; left: 10px; width: 200px; padding: 3px 8px; color: var(--vscode-input-foreground); background: transparent; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 4px; font: inherit; }
  #filtro:focus { background: var(--vscode-input-background); }
  #info { position: absolute; bottom: 10px; left: 10px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  #controles { position: absolute; top: 10px; right: 10px; display: flex; gap: 2px; }
  #controles button { min-width: 26px; padding: 2px 7px; color: var(--vscode-descriptionForeground); background: transparent; border: 1px solid transparent; border-radius: 4px; font: inherit; cursor: pointer; }
  #controles button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  canvas:focus-visible, #filtro:focus-visible, #controles button:focus-visible, .so-leitor button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  .so-leitor { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  .so-leitor:focus-within { position: absolute; top: 40px; left: 8px; width: auto; height: auto; max-width: 60%; margin: 0; padding: 4px; overflow: auto; max-height: 40%; clip-path: none; white-space: normal; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-focusBorder); }
</style>
<title>${l10n.t('Vault graph')}</title>
</head>
<body>
<canvas id="grafo" tabindex="0" role="application" aria-label="${l10n.t('Graph of vault notes')}" aria-describedby="ajuda"></canvas>
<ul id="links-da-nota" class="so-leitor" aria-label="${l10n.t('Links of the focused note')}"></ul>
<input id="filtro" type="search" placeholder="${l10n.t('Filter notes')}" aria-label="${l10n.t('Filter notes')}">
<div id="controles" role="group" aria-label="${l10n.t('Graph zoom')}"><button id="zoom-menos" type="button" aria-label="${l10n.t('Zoom out')}" title="${l10n.t('Zoom out')}">-</button><button id="zoom-reiniciar" type="button" aria-label="${l10n.t('Reset view')}" title="${l10n.t('Reset view')}">1:1</button><button id="zoom-mais" type="button" aria-label="${l10n.t('Zoom in')}" title="${l10n.t('Zoom in')}">+</button></div>
<div id="info"></div>
<p id="ajuda" class="so-leitor">${l10n.t('Arrow keys move to the nearest note in that direction. Page Down and Page Up go through the notes in alphabetical order. Enter opens the note. Plus and minus zoom, zero resets the view. Escape leaves the graph.')}</p>
<div id="anuncio" class="so-leitor" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  // ---------------------------------------------------------------- templates

  private async insertTemplate(): Promise<void> {
    const root = this.root();
    const editor = vscode.window.activeTextEditor;
    if (!root) {
      void vscode.window.showInformationMessage(l10n.t('Set up the vault first.'));
      return;
    }
    if (!editor) {
      void vscode.window.showInformationMessage(l10n.t('Open a note to insert the template.'));
      return;
    }
    const dir = join(root, 'Templates');
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md')).sort();
    if (files.length === 0) {
      void vscode.window.showInformationMessage(
        l10n.t(
          'No templates in Templates/. Create notes there, with {{title}}, {{date}} and {{time}} wherever you want.',
        ),
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      files.map((f) => ({ label: f.replace(/\.md$/, ''), file: f })),
      { title: l10n.t('Insert template'), placeHolder: l10n.t('Which template?') },
    );
    if (!picked) return;
    const text = await readFile(join(dir, picked.file), 'utf8');
    const title = basename(editor.document.uri.fsPath).replace(/\.md$/i, '');
    await editor.edit((edit) => {
      edit.replace(editor.selection, fillTemplate(text, title));
    });
  }
}
