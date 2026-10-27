import { relative, sep } from 'node:path';

import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

import { NoteTree, type TreeNode } from './vault-tree-model.js';

/**
 * Explorador de notas do vault: pastas e notas na barra lateral, com a nota
 * aberta no editor sempre à vista. Os caminhos vêm do `VaultUi`, que já lê o
 * índice do Core e avisa quando ele muda.
 */
export class VaultNotesUi implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly view: vscode.TreeView<TreeNode>;
  private tree = new NoteTree([]);

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly root: () => string | undefined,
    private readonly notes: () => readonly string[],
    onDidChangeNotes: vscode.Event<void>,
  ) {
    this.view = vscode.window.createTreeView('fakl.vault.notes', {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.disposables.push(
      this.changed,
      this.view,
      onDidChangeNotes(() => {
        this.refresh();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.reveal(editor?.document.uri);
      }),
      this.view.onDidChangeVisibility((event) => {
        if (event.visible) void this.reveal(vscode.window.activeTextEditor?.document.uri);
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  private refresh(): void {
    this.tree = new NoteTree(this.notes());
    this.view.message =
      this.root() && this.tree.size === 0 ? l10n.t('No notes in the vault yet.') : '';
    this.changed.fire(undefined);
    void this.reveal(vscode.window.activeTextEditor?.document.uri);
  }

  /** Marca no explorador a nota que está aberta, abrindo as pastas até ela. */
  private async reveal(uri: vscode.Uri | undefined): Promise<void> {
    const root = this.root();
    if (!root || !this.view.visible || uri?.scheme !== 'file') return;
    const rel = relative(root, uri.fsPath).split(sep).join('/');
    if (rel.startsWith('..') || !this.tree.has(rel)) return;
    try {
      await this.view.reveal(this.tree.noteNode(rel), { select: true, focus: false, expand: true });
    } catch {
      // A árvore pode ter mudado no meio do caminho; o próximo evento tenta de novo.
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `dir:${node.path}`;
      item.description = String(node.count);
      item.tooltip = node.path;
      item.contextValue = 'folder';
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = `note:${node.path}`;
    item.tooltip = node.path;
    item.contextValue = 'note';
    item.command = {
      command: 'fakl.vault.openNote',
      title: l10n.t('Open'),
      arguments: [node.path],
    };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!this.root() || node?.kind === 'note') return [];
    return this.tree.children(node?.path ?? '');
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return this.tree.parent(node);
  }
}
