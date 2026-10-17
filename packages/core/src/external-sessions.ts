import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ExternalListResult,
  ExternalSession,
  ExternalSessionState,
  ExternalSource,
} from '@fakl/protocol';

import { objectParams, RpcError, type Router } from './rpc/router.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Conversa mexida há mais que isto some da lista. */
const RECENT_MS = 7 * DAY_MS;
/** Arquivo que mexeu há menos que isto conta como conversa ativa. */
const ACTIVE_MS = 2 * 60 * 1000;
/** Quantas conversas de cada ferramenta a lista traz. */
const PER_SOURCE = 20;
/** Quantos arquivos de cada ferramenta o leitor abre por varredura. */
const MAX_OPENED = 60;
/** Quantos arquivos do Codex o leitor mede (mtime) por varredura. */
const MAX_CODEX_FILES = 400;
/** Dias de pastas do Codex (AAAA/MM/DD) percorridas. */
const CODEX_DAYS = 30;
/** O começo do arquivo traz o `session_meta` do Codex, que pode carregar instruções longas. */
const HEAD_BYTES = 1024 * 1024;
/** O fim do arquivo do Claude traz o título da conversa. */
const TAIL_BYTES = 256 * 1024;
const MAX_TITLE = 120;

export interface ExternalSessionsOptions {
  /** Pasta pessoal; de lá saem `.codex` e `.claude` quando o ambiente não diz outra. */
  readonly home: string;
  /** `CODEX_HOME` e `CLAUDE_CONFIG_DIR`, como o Core entrega aos agentes. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Consentimento do usuário (`sessoesExternas` do config.yaml); lido a cada chamada. */
  readonly enabled: () => boolean;
  /** Grava o consentimento; sem ele, `external.setEnabled` recusa. */
  readonly save?: (enabled: boolean) => Promise<unknown>;
  /** Tira segredos de qualquer texto que a interface vai mostrar. */
  readonly redact?: (text: string) => string;
  readonly clock?: () => Date;
  /** O processo com esse pid ainda existe? Muda nos testes. */
  readonly isAlive?: (pid: number) => boolean;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Uma linha de JSONL; qualquer coisa que não seja um objeto vira `undefined`. */
function parseLine(line: string): Json | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Só leitura: abre com `r` e lê `length` bytes a partir de `position`. */
async function readRange(file: string, position: number, length: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readHead(file: string, size: number): Promise<(Json | undefined)[]> {
  const lines = (await readRange(file, 0, Math.min(size, HEAD_BYTES))).split('\n');
  // A última linha pode ter sido cortada no limite da leitura.
  if (size > HEAD_BYTES) lines.pop();
  return lines.map(parseLine);
}

async function readTail(file: string, size: number): Promise<(Json | undefined)[]> {
  const start = Math.max(0, size - TAIL_BYTES);
  const lines = (await readRange(file, start, size - start)).split('\n');
  // Começando no meio do arquivo, a primeira linha vem pela metade.
  if (start > 0) lines.shift();
  return lines.map(parseLine);
}

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

interface Candidate {
  readonly file: string;
  readonly mtimeMs: number;
  readonly size: number;
}

async function measure(file: string): Promise<Candidate | undefined> {
  const info = await stat(file).catch(() => undefined);
  return info?.isFile() ? { file, mtimeMs: info.mtimeMs, size: info.size } : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: o processo existe, só não é nosso.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Conversas das extensões oficiais do Codex (`openai.chatgpt`) e do Claude Code
 * (`anthropic.claude-code`), só para olhar (ADR 0038). As duas guardam o
 * histórico em JSONL num formato interno, sem documentação; por isso o leitor
 * só confia no que consegue ler, ignora o resto sem reclamar e nunca grava
 * nada nesses arquivos. Só metadados saem daqui: título, pasta, horário e
 * estado; o texto das mensagens não é lido nem mostrado.
 *
 * Fica desligado até o usuário consentir, porque ler o histórico de outras
 * ferramentas é uma decisão dele.
 */
export class ExternalSessionsService {
  constructor(private readonly options: ExternalSessionsOptions) {}

  get enabled(): boolean {
    return this.options.enabled();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.options.save) {
      throw RpcError.invalidParams('external.setEnabled needs the config.yaml');
    }
    await this.options.save(enabled);
  }

  /** Vazio enquanto o consentimento não existe; nunca lança por causa dos arquivos. */
  async list(): Promise<ExternalListResult> {
    if (!this.enabled) return { ativo: false, sessoes: [] };
    const [codex, claude] = await Promise.all([
      this.codex().catch((): ExternalSession[] => []),
      this.claude().catch((): ExternalSession[] => []),
    ]);
    const sessoes = [...codex, ...claude].sort((a, b) =>
      b.atualizadaEm.localeCompare(a.atualizadaEm),
    );
    return { ativo: true, sessoes };
  }

  register(router: Router): void {
    router.register('external.status', () => ({ ativo: this.enabled }));
    router.register('external.setEnabled', async (params) => {
      const p = objectParams(params);
      if (typeof p.ativo !== 'boolean') throw RpcError.invalidParams('ativo must be a boolean');
      await this.setEnabled(p.ativo);
      return { ativo: this.enabled };
    });
    router.register('external.list', () => this.list());
  }

  private redact(value: string): string {
    return this.options.redact?.(value) ?? value;
  }

  private get now(): number {
    return (this.options.clock?.() ?? new Date()).getTime();
  }

  private title(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const flat = this.redact(value.replace(/\s+/g, ' ').trim());
    if (!flat) return undefined;
    return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
  }

  private session(
    fonte: ExternalSource,
    sessionId: string,
    candidate: Candidate,
    pasta: string,
    titulo: string | undefined,
    busy: boolean,
  ): ExternalSession {
    const estado: ExternalSessionState =
      busy || this.now - candidate.mtimeMs < ACTIVE_MS ? 'ativa' : 'parada';
    return {
      id: `${fonte}:${sessionId}`,
      fonte,
      sessionId,
      provedor: fonte === 'codex' ? 'openai' : 'anthropic',
      ...(titulo ? { titulo } : {}),
      pasta: this.redact(pasta),
      estado,
      atualizadaEm: new Date(candidate.mtimeMs).toISOString(),
    };
  }

  private recent(candidates: Candidate[]): Candidate[] {
    const limit = this.now - RECENT_MS;
    return candidates.filter((c) => c.mtimeMs >= limit).sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  // Codex: `<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-*.jsonl`.

  private async codex(): Promise<ExternalSession[]> {
    const root = this.options.env?.CODEX_HOME ?? join(this.options.home, '.codex');
    const candidates = await this.codexFiles(join(root, 'sessions'));
    const titles = await this.codexTitles(join(root, 'session_index.jsonl'));
    const found: ExternalSession[] = [];
    for (const candidate of candidates.slice(0, MAX_OPENED)) {
      if (found.length >= PER_SOURCE) break;
      const head = await readHead(candidate.file, candidate.size).catch(() => []);
      const meta = head.slice(0, 8).find((line) => line?.type === 'session_meta');
      const payload = meta?.payload;
      // O codex-acp do Core marca `originator: fakl-code`; essas já estão na Mesa.
      if (!isObject(payload) || payload.originator !== 'codex_vscode') continue;
      const sessionId = text(payload.id);
      const pasta = text(payload.cwd);
      if (!sessionId || !pasta) continue;
      found.push(this.session('codex', sessionId, candidate, pasta, titles.get(sessionId), false));
    }
    return found;
  }

  /** Arquivos dos últimos dias, os mais recentes primeiro; as pastas já vêm datadas. */
  private async codexFiles(sessions: string): Promise<Candidate[]> {
    const limit = this.now - CODEX_DAYS * DAY_MS;
    const found: Candidate[] = [];
    const numbers = (names: string[]): string[] =>
      names
        .filter((name) => /^\d+$/.test(name))
        .sort()
        .reverse();
    for (const year of numbers(await listDir(sessions))) {
      for (const month of numbers(await listDir(join(sessions, year)))) {
        for (const day of numbers(await listDir(join(sessions, year, month)))) {
          const date = new Date(Number(year), Number(month) - 1, Number(day)).getTime();
          if (date < limit) continue;
          const dir = join(sessions, year, month, day);
          for (const name of await listDir(dir)) {
            if (!/^rollout-.*\.jsonl$/.test(name) || found.length >= MAX_CODEX_FILES) continue;
            const candidate = await measure(join(dir, name));
            if (candidate) found.push(candidate);
          }
        }
      }
    }
    return this.recent(found);
  }

  /** `session_index.jsonl`: `{id, thread_name}` por linha; a última de cada id vale. */
  private async codexTitles(file: string): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    const content = await readFile(file, 'utf8').catch(() => '');
    for (const line of content.split('\n')) {
      const entry = parseLine(line);
      const id = text(entry?.id);
      const title = this.title(text(entry?.thread_name));
      if (id && title) titles.set(id, title);
    }
    return titles;
  }

  // Claude Code: `<CLAUDE_CONFIG_DIR>/projects/<pasta codificada>/<sessionId>.jsonl`.

  private async claude(): Promise<ExternalSession[]> {
    const root = this.options.env?.CLAUDE_CONFIG_DIR ?? join(this.options.home, '.claude');
    const projects = join(root, 'projects');
    const all: Candidate[] = [];
    for (const dir of await listDir(projects)) {
      for (const name of await listDir(join(projects, dir))) {
        if (!name.endsWith('.jsonl')) continue;
        const candidate = await measure(join(projects, dir, name));
        if (candidate) all.push(candidate);
      }
    }
    const live = await this.claudeLive(join(root, 'sessions'));
    const found: ExternalSession[] = [];
    for (const candidate of this.recent(all).slice(0, MAX_OPENED)) {
      if (found.length >= PER_SOURCE) break;
      const head = await readHead(candidate.file, candidate.size).catch(() => []);
      // `entrypoint` fica nas linhas de mensagem; `claude-vscode` é a extensão
      // e `sdk-ts` são os agentes do Core (claude-agent-acp).
      const first = head.find((line) => text(line?.entrypoint) !== undefined);
      if (first?.entrypoint !== 'claude-vscode') continue;
      const sessionId = text(first.sessionId);
      const pasta = text(first.cwd);
      if (!sessionId || !pasta) continue;
      const tail = await readTail(candidate.file, candidate.size).catch(() => []);
      const titulo = this.claudeTitle(tail, live.get(sessionId)?.name);
      const busy = live.get(sessionId)?.busy === true;
      found.push(this.session('claude-code', sessionId, candidate, pasta, titulo, busy));
    }
    return found;
  }

  /** Nome dado à conversa (`custom-title`, depois `agent-name`), do fim do arquivo. */
  private claudeTitle(
    tail: readonly (Json | undefined)[],
    liveName: string | undefined,
  ): string | undefined {
    let custom: string | undefined;
    let agent: string | undefined;
    for (const line of tail) {
      if (line?.type === 'custom-title') custom = text(line.customTitle) ?? custom;
      if (line?.type === 'agent-name') agent = text(line.agentName) ?? agent;
    }
    return this.title(custom ?? agent ?? liveName);
  }

  /** `sessions/<pid>.json`: sessões vivas, com `status` e `name`. */
  private async claudeLive(dir: string): Promise<Map<string, { busy: boolean; name?: string }>> {
    const live = new Map<string, { busy: boolean; name?: string }>();
    const isAlive = this.options.isAlive ?? processExists;
    for (const name of await listDir(dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const entry = await readFile(join(dir, name), 'utf8')
        .then((content): unknown => JSON.parse(content))
        .catch(() => undefined);
      if (!isObject(entry)) continue;
      const sessionId = text(entry.sessionId);
      const pid = typeof entry.pid === 'number' ? entry.pid : undefined;
      if (!sessionId || pid === undefined || !isAlive(pid)) continue;
      const label = text(entry.name);
      live.set(sessionId, { busy: entry.status === 'busy', ...(label ? { name: label } : {}) });
    }
    return live;
  }
}
