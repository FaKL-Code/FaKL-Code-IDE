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
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    redirect?: 'error';
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const CHUNK_CHARS = 800;
const BATCH = 16;
/** API remota: lotes maiores, menos pedidos (os limites são por pedido e por minuto). */
const REMOTE_BATCH = 64;
const MAX_RETRIES = 4;
const BACKOFF_MS = 1000;
const MAX_WAIT_MS = 30_000;
/** Estimativa de tokens: ~4 caracteres por token, o suficiente para um aviso de custo. */
const CHARS_PER_TOKEN = 4;
const SAVE_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 60_000;
const STORE_VERSION = 1;
/** Vetores de trechos que saíram do índice (nota renomeada, trecho editado e desfeito), por hash do texto. */
const RESERVE_MAX = 3000;
/** Perguntas já embutidas nesta sessão; a mesma pergunta não volta à API. */
const QUERY_CACHE_MAX = 100;

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
  readonly provedor?: string;
  readonly modelo: string;
  readonly endpoint: string;
  readonly notas: Record<string, { hash: string; trechos: { texto: string; vetor: string }[] }>;
  /** `{ sha1 do texto: vetor }`; só o hash, o texto do trecho não vai para cá. */
  readonly reserva?: Record<string, string>;
}

export interface SemanticStatus {
  readonly ativa: boolean;
  readonly modelo?: string;
  readonly endpoint?: string;
  readonly indexadas: number;
  readonly pendentes: number;
  readonly erro?: string;
  /** API remota: as notas saem da máquina para `servidor`. */
  readonly remota?: boolean;
  /** Servidor (host e porta) que receberia as notas; só em API remota. */
  readonly servidor?: string;
  /** API remota sem a confirmação do envio para o servidor atual: nada é enviado. */
  readonly aguardaConfirmacao?: boolean;
  /** API remota: há chave no cofre. */
  readonly chave?: boolean;
  /** O que ainda seria enviado (só enquanto aguarda a confirmação). */
  readonly estimativa?: SemanticEstimate;
}

/** Custo aproximado de indexar o que falta, para o aviso antes de enviar. */
export interface SemanticEstimate {
  readonly notas: number;
  readonly trechos: number;
  readonly tokens: number;
}

export function isRemoteSemantic(config: SemanticConfig): boolean {
  return config.provedor === 'openai';
}

/** Servidor (host e porta) de um endpoint; vazio se o endereço não for válido. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
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

function textKey(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SemanticIndexOptions {
  readonly config: SemanticConfig;
  /** Arquivo dos vetores; sem ele, ficam só em memória. */
  readonly file?: string;
  readonly fetch?: EmbedFetch;
  readonly log?: (message: string) => void;
  /** Chave da API remota, lida do cofre a cada pedido; nunca vai a arquivo, log ou erro. */
  readonly apiKey?: () => string | undefined;
  /** Espera entre tentativas do 429; injetável para os testes. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Avisa o que o cache poupou de enviar ao servidor de embeddings (trechos ou perguntas, e caracteres). */
  readonly economizou?: (poupado: { itens: number; caracteres: number }) => void;
}

/**
 * Busca semântica no vault (RF-407, ADR 0013 e 0050). Os vetores vêm de um modelo de
 * embeddings num servidor local (Ollama ou LM Studio), então o texto das notas
 * não sai da máquina, ou de uma API compatível com a da OpenAI, caso em que sai: só
 * depois de a pessoa confirmar o servidor (`confirmadoPara`) e com a chave do cofre.
 * Notas privadas nunca são enviadas ao modelo. O índice é incremental: só trechos
 * cujo conteúdo mudou são recalculados, e vetores de outro modelo são descartados.
 */
export class SemanticIndex {
  private readonly entries = new Map<string, Entry>();
  /** Vetores de trechos que saíram do índice, por hash do texto, do mais antigo ao mais novo. */
  private readonly reserve = new Map<string, Float32Array>();
  private readonly queryCache = new Map<string, Float32Array>();
  private readonly queue = new Set<string>();
  private working: Promise<void> | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private index: VaultIndex | undefined;
  private lastError: string | undefined;
  private disposed = false;
  private readonly endpoint: string;
  private readonly fetcher: EmbedFetch;
  private readonly remote: boolean;

  constructor(private readonly options: SemanticIndexOptions) {
    this.endpoint = semanticEndpoint(options.config);
    this.fetcher = options.fetch ?? fetch;
    this.remote = isRemoteSemantic(options.config);
  }

  /** API remota sem confirmação do envio para este servidor: não há pedido nenhum. */
  private get awaiting(): boolean {
    return (
      this.remote &&
      (this.options.config.confirmadoPara === undefined ||
        this.options.config.confirmadoPara !== endpointHost(this.endpoint))
    );
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
      if (note.private) this.drop(note.path, false);
      else if (this.entries.get(note.path)?.hash !== hashOf(note)) this.queue.add(note.path);
    }
    for (const path of [...this.entries.keys()]) if (!present.has(path)) this.drop(path);
    this.kick();
  }

  status(): SemanticStatus {
    const awaiting = this.awaiting;
    return {
      ativa: true,
      modelo: this.options.config.modelo,
      endpoint: this.endpoint,
      indexadas: this.entries.size,
      pendentes: awaiting ? this.pending().length : this.queue.size,
      ...(this.lastError ? { erro: this.lastError } : {}),
      ...(this.remote
        ? {
            remota: true,
            servidor: endpointHost(this.endpoint),
            chave: Boolean(this.options.apiKey?.()),
            ...(awaiting ? { aguardaConfirmacao: true, estimativa: this.estimate() } : {}),
          }
        : {}),
    };
  }

  /** Notas públicas cujo conteúdo ainda não tem vetor. */
  private pending(): IndexedNote[] {
    return (this.index?.all() ?? []).filter(
      (note) => !note.private && this.entries.get(note.path)?.hash !== hashOf(note),
    );
  }

  /** Tokens aproximados do que seria enviado, descontando trechos já em cache. */
  estimate(): SemanticEstimate {
    const cache = this.vectorCache();
    let notes = 0;
    let chunks = 0;
    let chars = 0;
    for (const note of this.pending()) {
      const missing = chunkNote(note.title, note.body).filter((text) => !cache.has(text));
      if (missing.length === 0) continue;
      notes++;
      chunks += missing.length;
      chars += missing.reduce((sum, text) => sum + text.length, 0);
    }
    return { notas: notes, trechos: chunks, tokens: Math.ceil(chars / CHARS_PER_TOKEN) };
  }

  /** Vetores já calculados por conteúdo do trecho (título incluso): o cache entre notas. */
  private vectorCache(): Map<string, Float32Array> {
    const cache = new Map<string, Float32Array>();
    for (const entry of this.entries.values()) {
      for (const chunk of entry.chunks) cache.set(chunk.text, chunk.vector);
    }
    return cache;
  }

  /** Espera a fila esvaziar (testes e a primeira busca). */
  async idle(): Promise<void> {
    while (this.working) await this.working;
  }

  async search(query: string, limit = 20): Promise<SearchHit[]> {
    const index = this.index;
    if (!index) return [];
    const vector = await this.queryVector(query);
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

  /** Vetor da pergunta: a mesma pergunta (sem contar espaços) não é embutida duas vezes. */
  private async queryVector(query: string): Promise<Float32Array | undefined> {
    const key = query.replace(/\s+/g, ' ').trim();
    const cached = this.queryCache.get(key);
    if (cached) {
      // Reinsere para a pergunta mais usada ser a última a sair.
      this.queryCache.delete(key);
      this.queryCache.set(key, cached);
      this.options.economizou?.({ itens: 1, caracteres: key.length });
      return cached;
    }
    const [vector] = await this.embed([query]);
    if (!vector) return undefined;
    this.queryCache.set(key, vector);
    if (this.queryCache.size > QUERY_CACHE_MAX) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    return vector;
  }

  /** Guarda na reserva os trechos de uma entrada que saiu, menos os que continuam no índice. */
  private reservar(entry: Entry | undefined, keep: ReadonlySet<string> = new Set()): void {
    if (!entry) return;
    for (const chunk of entry.chunks) {
      if (keep.has(chunk.text) || chunk.vector.length === 0) continue;
      const key = textKey(chunk.text);
      this.reserve.delete(key);
      this.reserve.set(key, chunk.vector);
    }
    while (this.reserve.size > RESERVE_MAX) {
      const oldest = this.reserve.keys().next().value;
      if (oldest === undefined) break;
      this.reserve.delete(oldest);
    }
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
      if (!note || note.private) this.drop(path, note === undefined);
      else if (this.entries.get(path)?.hash !== hashOf(note)) this.queue.add(path);
    }
    this.kick();
  }

  /** Tira a nota do índice. `reservar`: guarda os vetores (nota apagada ou movida); nota que virou privada não. */
  private drop(path: string, reservar = true): void {
    this.queue.delete(path);
    const entry = this.entries.get(path);
    if (this.entries.delete(path)) {
      if (reservar) this.reservar(entry);
      this.scheduleSave();
    }
  }

  private kick(): void {
    if (this.working || this.queue.size === 0 || this.disposed || this.awaiting) return;
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
        // Trechos iguais aos já calculados (desta ou de outra nota) não são reenviados.
        const cache = this.vectorCache();
        // Trecho de uma nota renomeada ou editada e desfeita ainda está na reserva.
        for (const text of texts) {
          const kept = cache.has(text) ? undefined : this.reserve.get(textKey(text));
          if (kept) cache.set(text, kept);
        }
        const unique = [...new Set(texts)];
        const missing = unique.filter((text) => !cache.has(text));
        const reused = unique.filter((text) => !missing.includes(text));
        if (reused.length > 0) {
          this.options.economizou?.({
            itens: reused.length,
            caracteres: reused.reduce((sum, text) => sum + text.length, 0),
          });
        }
        const size = this.remote ? REMOTE_BATCH : BATCH;
        for (let i = 0; i < missing.length; i += size) {
          const part = missing.slice(i, i + size);
          const vectors = await this.embed(part);
          part.forEach((text, at) => cache.set(text, vectors[at] ?? new Float32Array()));
        }
        // Fechado durante o pedido: o resultado não vale mais.
        if (this.closed()) return;
        const previous = this.entries.get(path);
        this.entries.set(path, {
          hash,
          chunks: texts.map((text) => ({ text, vector: cache.get(text) ?? new Float32Array() })),
        });
        this.reservar(previous, new Set(texts));
        this.scheduleSave();
      } catch (error) {
        this.queue.add(path);
        this.lastError = this.scrub(errorText(error));
        this.options.log?.(l10n.t('semantic search: {0}', this.lastError));
        return;
      }
    }
  }

  /** Tira a chave de qualquer texto que vá a erro ou log (servidores às vezes a repetem). */
  private scrub(text: string): string {
    const key = this.options.apiKey?.();
    return key ? text.split(key).join('***') : text;
  }

  private async embed(inputs: readonly string[]): Promise<Float32Array[]> {
    if (this.awaiting) throw new Error(l10n.t('embeddings: sending the notes was not confirmed'));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.remote) {
      const key = this.options.apiKey?.();
      if (!key) {
        throw new Error(
          l10n.t('embeddings: no API key saved; use "FaKL: Save the embeddings API key"'),
        );
      }
      // `authorization` é o padrão da OpenAI e afins; `api-key`, o do Azure.
      headers.authorization = `Bearer ${key}`;
      headers['api-key'] = key;
    }
    const sleep = this.options.sleep ?? sleepFor;
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(`${this.endpoint}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.options.config.modelo, input: inputs }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A chave só vai ao servidor configurado, nunca a um redirecionamento.
        ...(this.remote ? { redirect: 'error' as const } : {}),
      }).catch((error: unknown) => {
        throw new Error(
          this.scrub(
            l10n.t(
              'the embeddings server at {0} did not respond ({1})',
              this.endpoint,
              errorText(error),
            ),
          ),
        );
      });
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const asked = Number(response.headers?.get('retry-after'));
        const wait = Number.isFinite(asked) && asked > 0 ? asked * 1000 : BACKOFF_MS * 2 ** attempt;
        await sleep(Math.min(MAX_WAIT_MS, wait));
        if (this.disposed) throw new Error(l10n.t('embeddings: closed'));
        continue;
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            l10n.t(
              'embeddings: the server refused the API key (HTTP {0})',
              String(response.status),
            ),
          );
        }
        if (response.status === 429) {
          throw new Error(l10n.t('embeddings: rate limit (HTTP 429); will try again later'));
        }
        const detail = this.scrub((await response.text().catch(() => '')).slice(0, 200));
        throw new Error(l10n.t('embeddings: HTTP {0} {1}', String(response.status), detail).trim());
      }
      return this.parse(await response.json().catch(() => undefined), inputs.length);
    }
  }

  private parse(body: unknown, expected: number): Float32Array[] {
    const data = (body as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data) || data.length !== expected) {
      throw new Error(l10n.t('embeddings: incomplete response'));
    }
    const items = (data as ({ embedding?: unknown; index?: unknown } | null)[]).map(
      (item, position) => ({
        embedding: item?.embedding,
        at: typeof item?.index === 'number' ? item.index : position,
      }),
    );
    items.sort((a, b) => a.at - b.at);
    const first = items[0]?.embedding;
    const size = Array.isArray(first) ? first.length : 0;
    const vectors: number[][] = [];
    for (const { embedding } of items) {
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        embedding.length !== size ||
        !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new Error(l10n.t('embeddings: malformed response'));
      }
      vectors.push(embedding as number[]);
    }
    return vectors.map((vector) => Float32Array.from(vector));
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
        (stored.provedor ?? this.options.config.provedor) !== this.options.config.provedor ||
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
      for (const [key, vector] of Object.entries(stored.reserva ?? {})) {
        this.reserve.set(key, decode(vector));
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
      provedor: this.options.config.provedor,
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
      reserva: Object.fromEntries([...this.reserve].map(([key, vector]) => [key, encode(vector)])),
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
