import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { LOCAL_ENDPOINTS } from '@fakl/agents';
import { l10n } from '@fakl/i18n';

import type { SemanticConfig } from '../config.js';
import type { IndexedNote, SearchHit, VaultIndex } from './index.js';

/** `fetch` injetável, para testes. */
export type EmbedFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const CHUNK_CHARS = 800;
const BATCH = 16;
const SAVE_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 60_000;
const STORE_VERSION = 1;

interface Chunk {
  readonly text: string;
  readonly vector: Float32Array;
}

interface Entry {
  readonly hash: string;
  readonly chunks: readonly Chunk[];
}

interface StoredFile {
  readonly versao: number;
  readonly modelo: string;
  readonly endpoint: string;
  readonly notas: Record<string, { hash: string; trechos: { texto: string; vetor: string }[] }>;
}

export interface SemanticStatus {
  readonly ativa: boolean;
  readonly modelo?: string;
  readonly endpoint?: string;
  readonly indexadas: number;
  readonly pendentes: number;
  readonly erro?: string;
}

/** Endereço base do servidor de embeddings, sem barra no fim. */
export function semanticEndpoint(config: SemanticConfig): string {
  return (config.endpoint ?? LOCAL_ENDPOINTS[config.provedor] ?? '').replace(/\/+$/, '');
}

/**
 * Trechos de uma nota para embeddings: parágrafos juntados até ~800
 * caracteres; um parágrafo maior é cortado. O título vai na frente de cada
 * trecho para dar contexto ao modelo.
 */
export function chunkNote(title: string, body: string): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  const push = (): void => {
    if (current) chunks.push(`${title}\n${current}`);
    current = '';
  };
  for (const paragraph of paragraphs) {
    for (let at = 0; at < paragraph.length; at += CHUNK_CHARS) {
      const piece = paragraph.slice(at, at + CHUNK_CHARS);
      if (current && current.length + piece.length + 1 > CHUNK_CHARS) push();
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  push();
  return chunks.length > 0 ? chunks : [title];
}

function hashOf(note: IndexedNote): string {
  return createHash('sha1').update(note.title).update('\0').update(note.body).digest('hex');
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

function decode(text: string): Float32Array {
  const bytes = Buffer.from(text, 'base64');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SemanticIndexOptions {
  readonly config: SemanticConfig;
  /** Arquivo dos vetores; sem ele, ficam só em memória. */
  readonly file?: string;
  readonly fetch?: EmbedFetch;
  readonly log?: (message: string) => void;
}

/**
 * Busca semântica no vault (RF-407, ADR 0013). Os vetores vêm de um modelo de
 * embeddings num servidor local (Ollama ou LM Studio), então o texto das notas
 * não sai da máquina. Notas privadas nunca são enviadas ao modelo. O índice é
 * incremental: só trechos de notas cujo conteúdo mudou são recalculados.
 */
export class SemanticIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly queue = new Set<string>();
  private working: Promise<void> | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private index: VaultIndex | undefined;
  private lastError: string | undefined;
  private disposed = false;
  private readonly endpoint: string;
  private readonly fetcher: EmbedFetch;

  constructor(private readonly options: SemanticIndexOptions) {
    this.endpoint = semanticEndpoint(options.config);
    this.fetcher = options.fetch ?? fetch;
  }

  /** Carrega os vetores gravados e indexa o que mudou desde a última vez. */
  async start(index: VaultIndex): Promise<void> {
    this.index = index;
    await this.load();
    this.unsubscribe = index.onDidChange((paths) => {
      if (paths.includes('*')) this.reconcile();
      else this.enqueue(paths);
    });
    this.reconcile();
  }

  /** Confere o índice inteiro: tira notas que sumiram e enfileira as que mudaram. */
  reconcile(): void {
    const index = this.index;
    if (!index || this.disposed) return;
    const present = new Set<string>();
    for (const note of index.all()) {
      present.add(note.path);
      if (note.private) this.drop(note.path);
      else if (this.entries.get(note.path)?.hash !== hashOf(note)) this.queue.add(note.path);
    }
    for (const path of [...this.entries.keys()]) if (!present.has(path)) this.drop(path);
    this.kick();
  }

  status(): SemanticStatus {
    return {
      ativa: true,
      modelo: this.options.config.modelo,
      endpoint: this.endpoint,
      indexadas: this.entries.size,
      pendentes: this.queue.size,
      ...(this.lastError ? { erro: this.lastError } : {}),
    };
  }

  /** Espera a fila esvaziar (testes e a primeira busca). */
  async idle(): Promise<void> {
    while (this.working) await this.working;
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const index = this.index;
    if (!index) return [];
    const [vector] = await this.embed([query]);
    if (!vector) return [];
    const best = new Map<string, { score: number; text: string }>();
    for (const [path, entry] of this.entries) {
      for (const chunk of entry.chunks) {
        const score = cosine(vector, chunk.vector);
        const current = best.get(path);
        if (!current || score > current.score) best.set(path, { score, text: chunk.text });
      }
    }
    const hits: SearchHit[] = [];
    for (const [path, { score, text }] of best) {
      const note = index.get(path);
      if (!note || note.private) continue;
      const snippet = text.slice(text.indexOf('\n') + 1, text.indexOf('\n') + 201).trim();
      hits.push({ path, title: note.title, tags: note.tags, snippet, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.queue.clear();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      void this.save();
    }
  }

  private closed(): boolean {
    return this.disposed;
  }

  private enqueue(paths: readonly string[]): void {
    const index = this.index;
    if (!index) return;
    for (const path of paths) {
      const note = index.get(path);
      if (!note || note.private) this.drop(path);
      else if (this.entries.get(path)?.hash !== hashOf(note)) this.queue.add(path);
    }
    this.kick();
  }

  private drop(path: string): void {
    this.queue.delete(path);
    if (this.entries.delete(path)) this.scheduleSave();
  }

  private kick(): void {
    if (this.working || this.queue.size === 0 || this.disposed) return;
    this.working = this.drain().finally(() => {
      this.working = undefined;
      // O que chegou enquanto a fila andava; um erro para a fila até a próxima mudança.
      if (!this.lastError) this.kick();
    });
  }

  private async drain(): Promise<void> {
    this.lastError = undefined;
    while (this.queue.size > 0 && !this.disposed) {
      const [path] = this.queue;
      if (path === undefined) break;
      this.queue.delete(path);
      const note = this.index?.get(path);
      if (!note || note.private) continue;
      const hash = hashOf(note);
      const texts = chunkNote(note.title, note.body);
      try {
        const vectors: Float32Array[] = [];
        for (let i = 0; i < texts.length; i += BATCH) {
          vectors.push(...(await this.embed(texts.slice(i, i + BATCH))));
        }
        // Fechado durante o pedido: o resultado não vale mais.
        if (this.closed()) return;
        this.entries.set(path, {
          hash,
          chunks: texts.map((text, i) => ({ text, vector: vectors[i] ?? new Float32Array() })),
        });
        this.scheduleSave();
      } catch (error) {
        this.queue.add(path);
        this.lastError = errorText(error);
        this.options.log?.(l10n.t('semantic search: {0}', this.lastError));
        return;
      }
    }
  }

  private async embed(inputs: readonly string[]): Promise<Float32Array[]> {
    const response = await this.fetcher(`${this.endpoint}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.options.config.modelo, input: inputs }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw new Error(
        l10n.t(
          'the embeddings server at {0} did not respond ({1})',
          this.endpoint,
          errorText(error),
        ),
        { cause: error },
      );
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(l10n.t('embeddings: HTTP {0} {1}', String(response.status), detail).trim());
    }
    const body = (await response.json()) as {
      data?: { embedding?: number[]; index?: number }[];
    };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== inputs.length) throw new Error(l10n.t('embeddings: incomplete response'));
    return data.map((item) => Float32Array.from(item.embedding ?? []));
  }

  private async load(): Promise<void> {
    const file = this.options.file;
    if (!file) return;
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (!text) return;
    try {
      const stored = JSON.parse(text) as StoredFile;
      // Outro modelo ou servidor: vetores incompatíveis, recomeça.
      if (
        stored.versao !== STORE_VERSION ||
        stored.modelo !== this.options.config.modelo ||
        stored.endpoint !== this.endpoint
      ) {
        return;
      }
      for (const [path, entry] of Object.entries(stored.notas)) {
        this.entries.set(path, {
          hash: entry.hash,
          chunks: entry.trechos.map((t) => ({ text: t.texto, vector: decode(t.vetor) })),
        });
      }
    } catch {
      // Arquivo corrompido: recomeça do zero.
    }
  }

  private scheduleSave(): void {
    if (!this.options.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private async save(): Promise<void> {
    const file = this.options.file;
    if (!file) return;
    const stored: StoredFile = {
      versao: STORE_VERSION,
      modelo: this.options.config.modelo,
      endpoint: this.endpoint,
      notas: Object.fromEntries(
        [...this.entries].map(([path, entry]) => [
          path,
          {
            hash: entry.hash,
            trechos: entry.chunks.map((c) => ({ texto: c.text, vetor: encode(c.vector) })),
          },
        ]),
      ),
    };
    try {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(stored));
      await rename(temp, file);
    } catch (error) {
      this.options.log?.(l10n.t('could not save the vectors: {0}', errorText(error)));
    }
  }
}
