import { isAbsolute, relative, sep } from 'node:path';

/*
 * Árvore de pastas e notas do vault, como o explorador de arquivos do Obsidian.
 * Lógica pura: recebe os caminhos das notas e devolve o que a barra lateral mostra.
 */

export interface FolderNode {
  readonly kind: 'folder';
  /** Caminho relativo ao vault, sem barra no fim. */
  readonly path: string;
  readonly name: string;
  /** Notas dentro da pasta, contando as subpastas. */
  readonly count: number;
}

export interface NoteNode {
  readonly kind: 'note';
  readonly path: string;
  /** Nome do arquivo sem `.md`, que é o que o Obsidian mostra. */
  readonly name: string;
}

export type TreeNode = FolderNode | NoteNode;

interface Folder {
  readonly folders: Set<string>;
  readonly notes: string[];
  count: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export class NoteTree {
  private readonly folders = new Map<string, Folder>();

  constructor(paths: readonly string[]) {
    for (const path of paths) this.add(path);
  }

  private folder(path: string): Folder {
    let folder = this.folders.get(path);
    if (!folder) {
      folder = { folders: new Set(), notes: [], count: 0 };
      this.folders.set(path, folder);
    }
    return folder;
  }

  private add(path: string): void {
    const dir = parentPath(path);
    this.folder(dir).notes.push(path);
    // Do vault até a pasta da nota: cada uma ganha a nota na conta e a pasta de baixo como filha.
    let walked = '';
    this.folder('').count++;
    for (const part of dir ? dir.split('/') : []) {
      const parent = walked;
      walked = walked ? `${walked}/${part}` : part;
      this.folder(parent).folders.add(walked);
      this.folder(walked).count++;
    }
  }

  get size(): number {
    return this.folders.get('')?.count ?? 0;
  }

  /** Há uma nota nesse caminho? */
  has(path: string): boolean {
    return this.folders.get(parentPath(path))?.notes.includes(path) ?? false;
  }

  /** Filhos de uma pasta (`''` é a raiz): pastas primeiro, depois notas, cada grupo em ordem alfabética. */
  children(folder = ''): TreeNode[] {
    const entry = this.folders.get(folder);
    if (!entry) return [];
    const folders = [...entry.folders]
      .sort((a, b) => collator.compare(baseName(a), baseName(b)))
      .map((path) => this.folderNode(path));
    const notes = entry.notes
      .map((path) => this.noteNode(path))
      .sort((a, b) => collator.compare(a.name, b.name) || a.path.localeCompare(b.path));
    return [...folders, ...notes];
  }

  /** A pasta que contém o item, ou `undefined` na raiz. */
  parent(node: TreeNode): FolderNode | undefined {
    const path = parentPath(node.path);
    return path ? this.folderNode(path) : undefined;
  }

  noteNode(path: string): NoteNode {
    return { kind: 'note', path, name: baseName(path).replace(/\.md$/i, '') };
  }

  private folderNode(path: string): FolderNode {
    return {
      kind: 'folder',
      path,
      name: baseName(path),
      count: this.folders.get(path)?.count ?? 0,
    };
  }
}

/**
 * Caminho de uma nota nova. Com `folder` (o menu de uma pasta do explorador), o título
 * fica dentro dela, mesmo com barras (`Sub/Ideia` vira `Pasta/Sub/Ideia`); sem pasta,
 * `Pasta/Título` é um caminho do vault e um título solto vai para a Inbox.
 */
export function newNotePath(title: string, folder?: string): string {
  const clean = title.trim().replace(/[\\:*?"<>|#^[\]]/g, '-');
  if (folder) return `${folder}/${clean}`;
  return clean.includes('/') ? clean : `Inbox/${clean}`;
}

/** Caminho relativo (com `/`) de `file` dentro de `root`, ou `undefined` se estiver fora. */
export function pathInside(root: string, file: string): string | undefined {
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}
