import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { isPrivate, parseNote, type ParsedNote } from './parse.js';

/** Pastas que a IDE não indexa nem altera. */
const IGNORED = new Set(['.obsidian', '.git', '.trash', 'node_modules']);

export interface IndexedNote extends ParsedNote {
  /** Caminho relativo à raiz, sempre com `/`. */
  readonly path: string;
  readonly mtimeMs: number;
  readonly private: boolean;
}

export interface SearchHit {
  readonly path: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly snippet: string;
  readonly score: number;
}

export interface SearchOptions {
  readonly limit?: number;
  /** Agentes nunca veem notas privadas. */
  readonly includePrivate?: boolean;
}

/** Sem acentos e em minúsculas, para a busca achar "decisao" em "decisão". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Índice em memória do vault (SDD 10.3): texto, tags, links e backlinks.
 * Atualizado por um observador de arquivos; com alguns milhares de notas, a
 * leitura inteira leva menos de um segundo.
 */
export class VaultIndex {
  private readonly notes = new Map<string, IndexedNote>();
  private watcher: FSWatcher | undefined;
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(paths: readonly string[]) => void>();

  constructor(readonly root: string) {}

  get size(): number {
    return this.notes.size;
  }

  /** Chamado com os caminhos que mudaram depois de cada atualização. */
  onDidChange(listener: (paths: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async build(): Promise<void> {
    this.notes.clear();
    for (const path of await this.walk('')) await this.update(path);
  }

  private async walk(dir: string): Promise<string[]> {
    const entries = await readdir(join(this.root, dir), { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...(await this.walk(path)));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
    }
    return files;
  }

  /** Relê uma nota; some do índice se o arquivo não existe mais. */
  async update(path: string): Promise<void> {
    const full = join(this.root, path);
    try {
      const [text, info] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
      const parsed = parseNote(path, text);
      this.notes.set(path, {
        ...parsed,
        path,
        mtimeMs: info.mtimeMs,
        private: isPrivate(parsed.frontmatter),
      });
    } catch {
      this.notes.delete(path);
    }
  }

  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, name) => {
        if (!name) return;
        const path = toPosix(name);
        if (path.split('/').some((part) => IGNORED.has(part))) return;
        if (!path.toLowerCase().endsWith('.md')) {
          // Uma pasta renomeada ou apagada: relê tudo.
          this.pending.add('*');
        } else {
          this.pending.add(path);
        }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.flush(), 200);
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // Sem observador recursivo, a busca usa o que foi lido ao abrir.
    }
  }

  private async flush(): Promise<void> {
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.includes('*')) await this.build();
    else for (const path of paths) await this.update(path);
    for (const listener of this.listeners) listener(paths);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  get(path: string): IndexedNote | undefined {
    return this.notes.get(path);
  }

  all(): IndexedNote[] {
    return [...this.notes.values()];
  }

  /**
   * Resolve o alvo de um wikilink como o Obsidian: caminho exato, depois nome
   * do arquivo em qualquer pasta (o mais raso vence).
   */
  resolve(target: string): IndexedNote | undefined {
    const clean = target.replace(/\\/g, '/').replace(/^\//, '');
    const withExt = clean.toLowerCase().endsWith('.md') ? clean : `${clean}.md`;
    const exact = this.notes.get(withExt);
    if (exact) return exact;
    const wanted = fold(withExt.split('/').pop() ?? withExt);
    const suffix = fold(withExt);
    return [...this.notes.values()]
      .filter((note) => {
        const path = fold(note.path);
        return clean.includes('/') ? path.endsWith(suffix) : path.split('/').pop() === wanted;
      })
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
  }

  backlinks(path: string, includePrivate = true): IndexedNote[] {
    const target = this.notes.get(path);
    if (!target) return [];
    return [...this.notes.values()].filter(
      (note) =>
        note.path !== path &&
        (includePrivate || !note.private) &&
        note.links.some((link) => this.resolve(link)?.path === path),
    );
  }

  /** Nós e arestas para o grafo (RF-403). */
  graph(includePrivate = true): {
    nodes: { path: string; title: string }[];
    edges: [string, string][];
  } {
    const visible = [...this.notes.values()].filter((n) => includePrivate || !n.private);
    const allowed = new Set(visible.map((n) => n.path));
    const edges: [string, string][] = [];
    for (const note of visible) {
      for (const link of note.links) {
        const to = this.resolve(link)?.path;
        if (to && allowed.has(to) && to !== note.path) edges.push([note.path, to]);
      }
    }
    return { nodes: visible.map((n) => ({ path: n.path, title: n.title })), edges };
  }

  tags(includePrivate = true): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const note of this.notes.values()) {
      if (!includePrivate && note.private) continue;
      for (const tag of note.tags) counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Busca por texto com filtros `tag:x` (ou `#x`) e `pasta:Projetos`. Todas
   * as palavras precisam aparecer; o título pesa mais que o corpo.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const words: string[] = [];
    const tags: string[] = [];
    const folders: string[] = [];
    for (const part of query.split(/\s+/).filter(Boolean)) {
      if (part.startsWith('tag:')) tags.push(fold(part.slice(4).replace(/^#/, '')));
      else if (part.startsWith('#') && part.length > 1) tags.push(fold(part.slice(1)));
      else if (part.startsWith('pasta:')) folders.push(fold(part.slice(6)).replace(/\/$/, ''));
      else words.push(fold(part));
    }
    const hits: SearchHit[] = [];
    for (const note of this.notes.values()) {
      if (note.private && !options.includePrivate) continue;
      const path = fold(note.path);
      if (folders.some((folder) => !path.startsWith(`${folder}/`))) continue;
      const noteTags = note.tags.map(fold);
      if (tags.some((tag) => !noteTags.some((t) => t === tag || t.startsWith(`${tag}/`)))) continue;
      const title = fold(note.title);
      const body = fold(note.body);
      let score = tags.length + folders.length > 0 ? 1 : 0;
      let first = -1;
      let ok = true;
      for (const word of words) {
        const inTitle = title.includes(word) || path.includes(word);
        let count = 0;
        let at = body.indexOf(word);
        if (at >= 0 && (first < 0 || at < first)) first = at;
        while (at >= 0 && count < 50) {
          count++;
          at = body.indexOf(word, at + word.length);
        }
        if (!inTitle && count === 0) {
          ok = false;
          break;
        }
        score += (inTitle ? 10 : 0) + count;
      }
      if (!ok || score === 0) continue;
      const start = Math.max(0, first - 60);
      const snippet = (first >= 0 ? note.body.slice(start, start + 200) : note.body.slice(0, 200))
        .replace(/\s+/g, ' ')
        .trim();
      hits.push({ path: note.path, title: note.title, tags: note.tags, snippet, score });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, options.limit ?? 30);
  }

  /** Caminho relativo seguro dentro do vault, ou `undefined` se sai dele. */
  relative(path: string): string | undefined {
    const rel = toPosix(relative(this.root, join(this.root, path)));
    if (!rel || rel.startsWith('..') || rel.split('/').some((p) => IGNORED.has(p)))
      return undefined;
    return rel;
  }
}
