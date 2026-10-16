import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

import { l10n } from '@fakl/i18n';
import type {
  ClaudeAccountAttribution,
  ClaudeAccountSlot,
  ClaudeAccountsState,
  ProviderWindows,
  UsageWindow,
  UsageWindowsResult,
} from '@fakl/protocol';

import { parseAttribution } from './claude-accounts.js';
import type { Router } from './rpc/router.js';

/**
 * Janelas de uso dos assinantes: a sessão de 5 horas, a cota diária do Gemini
 * e o limite semanal, lidas dos registros que os próprios CLIs já gravam
 * (ADR 0026). É o mesmo
 * cálculo da barra de status da extensão, para o overlay não depender dela.
 * Só os campos numéricos de uso e o horário são lidos; nada é gravado.
 */

export const SESSION_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 24 * 3_600_000;
const HOUR_MS = 3_600_000;
/** Provedores com cota de plano que os CLIs registram localmente. */
const PLAN_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

export interface UsageSample {
  readonly ts: number;
  readonly tokens: number;
}

/** Amostra de uma resposta do Claude; `id` identifica a resposta entre arquivos de retomada. */
export interface ClaudeSample extends UsageSample {
  readonly id?: string;
  /** Sessão do Claude Code da linha, para saber de que conta é o uso. */
  readonly sessionId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Linhas `.jsonl` do Claude Code: uma amostra por resposta do modelo.
 * Tokens de leitura de cache ficam de fora: quase não pesam na cota.
 */
export function parseClaudeLine(line: string, fileSessionId?: string): ClaudeSample | undefined {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return undefined;
  }
  const root = record(data);
  const message = record(root?.message);
  const usage = record(message?.usage);
  const ts = typeof root?.timestamp === 'string' ? Date.parse(root.timestamp) : NaN;
  if (!usage || Number.isNaN(ts)) return undefined;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const id = `${str(message?.id)}:${str(root?.requestId)}`;
  const tokens =
    num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_creation_input_tokens);
  if (tokens <= 0) return undefined;
  const sessionId = str(root?.sessionId) || fileSessionId;
  return {
    ts,
    tokens,
    ...(id === ':' ? {} : { id }),
    ...(sessionId ? { sessionId } : {}),
  };
}

/**
 * De que conta é o uso de uma resposta (ADR 0027): a entrada mais recente da
 * sessão com `desde` até `ts`; senão, a conta ativa naquele instante.
 */
function attributeSlot(
  sessionId: string | undefined,
  ts: number,
  atribuicao: ClaudeAccountAttribution | undefined,
): ClaudeAccountSlot | null | undefined {
  if (!atribuicao) return undefined;
  const latest = (
    entries: ClaudeAccountAttribution['ativas'] | undefined,
  ): ClaudeAccountSlot | null | undefined => {
    let found: ClaudeAccountAttribution['ativas'][number] | undefined;
    for (const entry of entries ?? []) {
      if (entry.desde <= ts && (!found || entry.desde >= found.desde)) found = entry;
    }
    return found?.slot;
  };
  const own = sessionId ? latest(atribuicao.sessoes[sessionId]) : undefined;
  return own !== undefined ? own : latest(atribuicao.ativas);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Amostras do histórico comum por conta; a conta padrão e as desconhecidas ficam de fora. */
export function samplesBySlot(
  samples: readonly ClaudeSample[],
  atribuicao: ClaudeAccountAttribution | undefined,
): Map<ClaudeAccountSlot, UsageSample[]> {
  const bySlot = new Map<ClaudeAccountSlot, UsageSample[]>();
  const seen = new Set<string>();
  for (const sample of samples) {
    if (sample.id !== undefined) {
      if (seen.has(sample.id)) continue;
      seen.add(sample.id);
    }
    const slot = attributeSlot(sample.sessionId, sample.ts, atribuicao);
    if (slot === null || slot === undefined) continue;
    const list = bySlot.get(slot) ?? [];
    list.push({ ts: sample.ts, tokens: sample.tokens });
    bySlot.set(slot, list);
  }
  return bySlot;
}

/** As respostas repetem em arquivos de retomada: fica a primeira de cada `id`. */
export function uniqueSamples(samples: readonly ClaudeSample[]): UsageSample[] {
  const seen = new Set<string>();
  const result: UsageSample[] = [];
  for (const sample of samples) {
    if (sample.id !== undefined) {
      if (seen.has(sample.id)) continue;
      seen.add(sample.id);
    }
    result.push({ ts: sample.ts, tokens: sample.tokens });
  }
  return result;
}

/**
 * A sessão de 5 horas ativa: começa na hora cheia da primeira mensagem e dura
 * 5 horas; passada a janela (ou 5 horas sem uso), a próxima mensagem abre outra.
 */
export function activeSession(
  samples: readonly UsageSample[],
  now: number,
): UsageWindow | undefined {
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  let start = -1;
  let last = -1;
  let tokens = 0;
  for (const sample of sorted) {
    if (start < 0 || sample.ts >= start + SESSION_MS || sample.ts - last >= SESSION_MS) {
      start = Math.floor(sample.ts / HOUR_MS) * HOUR_MS;
      tokens = 0;
    }
    tokens += sample.tokens;
    last = sample.ts;
  }
  if (start < 0 || now >= start + SESSION_MS) return undefined;
  return { tokens, resetaEm: start + SESSION_MS };
}

/** Os últimos 7 dias corridos (a virada exata da semana depende da conta). */
export function weekTotal(samples: readonly UsageSample[], now: number): UsageWindow {
  const tokens = samples
    .filter((sample) => sample.ts > now - WEEK_MS && sample.ts <= now)
    .reduce((sum, sample) => sum + sample.tokens, 0);
  return { tokens };
}

/**
 * Última linha do Codex com `rate_limits`: o CLI grava o percentual usado e
 * quando cada janela zera (`primary` é a de 5 horas, `secondary` a semanal).
 */
export function parseCodexLimits(line: string): ProviderWindows | undefined {
  if (!line.includes('rate_limits')) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return undefined;
  }
  const limits = record(record(record(data)?.payload)?.rate_limits);
  if (!limits) return undefined;
  const window = (value: unknown): UsageWindow | undefined => {
    const w = record(value);
    if (!w || typeof w.used_percent !== 'number') return undefined;
    const resets = typeof w.resets_at === 'number' ? w.resets_at * 1000 : undefined;
    return {
      fracao: Math.max(0, Math.min(1, w.used_percent / 100)),
      ...(resets === undefined ? {} : { resetaEm: resets }),
    };
  };
  const sessao = window(limits.primary);
  const semana = window(limits.secondary);
  if (!sessao && !semana) return undefined;
  return {
    provedor: 'openai',
    ...(sessao ? { sessao } : {}),
    ...(semana ? { semana } : {}),
    origem: 'real',
  };
}

/** Amostra de uma resposta do Gemini CLI; `id` repete a cada reescrita da mensagem. */
export interface GeminiSample extends UsageSample {
  readonly id?: string;
}

function geminiMessage(value: unknown): GeminiSample | undefined {
  const message = record(value);
  if (message?.type !== 'gemini') return undefined;
  const usage = record(message.tokens);
  const ts = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
  if (!usage || Number.isNaN(ts)) return undefined;
  // Como no Claude, a leitura de cache quase não pesa na cota.
  const total =
    num(usage.total) ||
    num(usage.input) + num(usage.output) + num(usage.thoughts) + num(usage.tool);
  const tokens = Math.max(0, total - num(usage.cached));
  return { ts, tokens, ...(typeof message.id === 'string' ? { id: message.id } : {}) };
}

/**
 * Respostas numa linha do registro de conversa do Gemini CLI
 * (`~/.gemini/tmp/<projeto>/chats/session-*.jsonl`): uma mensagem solta ou
 * `$set.messages` com a conversa inteira. Só tokens, horário e id são lidos.
 */
export function parseGeminiLine(line: string): GeminiSample[] {
  if (!line.includes('"gemini"')) return [];
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return [];
  }
  const root = record(data);
  const messages = record(root?.$set)?.messages ?? root?.messages;
  const list: unknown[] = Array.isArray(messages) ? messages : [root];
  return list.map(geminiMessage).filter((sample): sample is GeminiSample => !!sample);
}

const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Meia-noite do Pacífico de hoje, quando a cota diária do Gemini zera. */
export function pacificDayStart(now: number): number {
  const parts = Object.fromEntries(
    PACIFIC.formatToParts(new Date(now)).map((part) => [part.type, Number(part.value)]),
  );
  const elapsed =
    ((parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)) * 1000 +
    (now % 1000);
  return now - elapsed;
}

/** Cota do Gemini: requisições e tokens desde a meia-noite do Pacífico, e a semana. */
export function geminiWindows(samples: readonly UsageSample[], now: number): ProviderWindows {
  const start = pacificDayStart(now);
  const today = samples.filter((sample) => sample.ts >= start && sample.ts <= now);
  return {
    provedor: 'google',
    dia: {
      requisicoes: today.length,
      tokens: today.reduce((sum, sample) => sum + sample.tokens, 0),
      resetaEm: start + 24 * HOUR_MS,
    },
    semana: weekTotal(samples, now),
    origem: 'estimado',
  };
}

/** Janela real que já zerou: o percentual guardado não vale mais. */
function unexpired(windows: ProviderWindows, now: number): ProviderWindows {
  const keep = (w: UsageWindow | undefined): UsageWindow | undefined =>
    w && (w.resetaEm === undefined || w.resetaEm > now) ? w : undefined;
  const sessao = keep(windows.sessao);
  const semana = keep(windows.semana);
  return {
    provedor: windows.provedor,
    ...(windows.nome ? { nome: windows.nome } : {}),
    ...(sessao ? { sessao } : {}),
    ...(semana ? { semana } : {}),
    origem: windows.origem,
  };
}

async function recentFiles(
  dir: string,
  since: number,
  wanted: (name: string) => boolean = (name) => name.endsWith('.jsonl'),
): Promise<{ path: string; mtime: number }[]> {
  const found: { path: string; mtime: number }[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (wanted(entry.name)) {
        const mtime = (await stat(path).catch(() => undefined))?.mtimeMs ?? 0;
        if (mtime >= since) found.push({ path, mtime });
      }
    }
  };
  await walk(dir);
  return found;
}

export interface UsageWindowsOptions {
  /** Estado das contas do Claude (`claude.accounts.list`); sem ele só vale a conta padrão do CLI. */
  readonly accounts?: () => Promise<ClaudeAccountsState | undefined>;
  /** Pasta pessoal onde ficam `.claude` e `.codex`. */
  readonly home?: string;
  /** Pasta do Codex; sem ela, `<home>/.codex`. */
  readonly codexHome?: string;
  /** Pasta do Gemini CLI; sem ela, `<home>/.gemini`. */
  readonly geminiHome?: string;
  /**
   * Provedores com perfil configurado: os de plano (Claude, Codex, Gemini)
   * sem registro de uso aparecem como "sem dados" em vez de sumir.
   */
  readonly providers?: () => readonly string[];
  readonly now?: () => number;
}

/** Lê e soma as janelas de uso; o que já foi lido de cada arquivo só é relido se mudou. */
export class UsageWindows {
  private readonly parsed = new Map<string, { mtime: number; samples: ClaudeSample[] }>();

  constructor(private readonly options: UsageWindowsOptions = {}) {}

  register(router: Router): void {
    router.register('usage.windows', () => this.read());
  }

  async read(): Promise<UsageWindowsResult> {
    const now = this.options.now?.() ?? Date.now();
    const home = this.options.home ?? homedir();
    const state = await this.options.accounts?.().catch(() => undefined);
    const accounts = state?.contas ?? [];
    const defaultDir = join(home, '.claude');
    const activeDir = state?.ativa
      ? accounts.find((account) => account.slot === state.ativa)?.dir
      : defaultDir;
    const sources: { nome: string; dir: string; slot?: ClaudeAccountSlot }[] = [
      { nome: accounts.length ? l10n.t('Default Claude') : 'Claude', dir: defaultDir },
      ...accounts
        .filter((account) => account.logada !== false)
        .map((account) => ({ nome: account.apelido, dir: account.dir, slot: account.slot })),
    ].sort((a, b) => Number(b.dir === activeDir) - Number(a.dir === activeDir));

    // O histórico comum dos slots é lido uma vez e repartido pela atribuição (ADR 0027).
    let shared: Map<ClaudeAccountSlot, UsageSample[]> | undefined;
    const sharedSamples = async (): Promise<Map<ClaudeAccountSlot, UsageSample[]>> => {
      if (!shared) {
        const raw = state?.atribuicao
          ? await readFile(state.atribuicao, 'utf8').catch(() => '')
          : '';
        const all = state?.compartilhada ? await this.claudeSamples(state.compartilhada, now) : [];
        shared = samplesBySlot(all, parseAttribution(parseJson(raw)));
      }
      return shared;
    };

    const rows: ProviderWindows[] = [];
    for (const source of sources) {
      const linked =
        source.slot !== undefined &&
        state?.compartilhada !== undefined &&
        (await lstat(join(source.dir, 'projects')).catch(() => undefined))?.isSymbolicLink();
      const samples =
        source.slot !== undefined && linked
          ? ((await sharedSamples()).get(source.slot) ?? [])
          : uniqueSamples(await this.claudeSamples(join(source.dir, 'projects'), now));
      if (samples.length === 0) continue;
      const sessao = activeSession(samples, now);
      rows.push({
        provedor: 'anthropic',
        nome: source.nome,
        ...(sessao ? { sessao } : {}),
        semana: weekTotal(samples, now),
        origem: 'estimado',
      });
    }
    const codex = await this.codexWindows(this.options.codexHome ?? join(home, '.codex'), now);
    if (codex) rows.push(unexpired(codex, now));
    const gemini = await this.geminiSamples(this.options.geminiHome ?? join(home, '.gemini'), now);
    if (gemini.length > 0) rows.push(geminiWindows(gemini, now));
    for (const provedor of this.options.providers?.() ?? []) {
      if (!PLAN_PROVIDERS.has(provedor) || rows.some((row) => row.provedor === provedor)) continue;
      rows.push({ provedor, origem: 'estimado', semDados: true });
    }
    return { janelas: rows };
  }

  /** Respostas do Claude Code nos últimos 7 dias, lidas do que o CLI já grava em `projects/`. */
  private async claudeSamples(projectsDir: string, now: number): Promise<ClaudeSample[]> {
    const files = await recentFiles(projectsDir, now - WEEK_MS);
    const all: ClaudeSample[] = [];
    const live = new Set<string>();
    for (const file of files) {
      live.add(file.path);
      let entry = this.parsed.get(file.path);
      if (entry?.mtime !== file.mtime) {
        const samples: ClaudeSample[] = [];
        const lines = createInterface({ input: createReadStream(file.path, 'utf8') });
        for await (const line of lines) {
          const sample = parseClaudeLine(line, basename(file.path, '.jsonl'));
          if (sample) samples.push(sample);
        }
        entry = { mtime: file.mtime, samples };
        this.parsed.set(file.path, entry);
      }
      all.push(...entry.samples);
    }
    // Arquivos que saíram da janela de 7 dias deste diretório deixam de ocupar memória.
    for (const path of this.parsed.keys()) {
      if (path.startsWith(projectsDir) && !live.has(path)) this.parsed.delete(path);
    }
    return all;
  }

  /** Respostas do Gemini CLI nos últimos 7 dias, dos registros de conversa de `tmp/`. */
  private async geminiSamples(geminiHome: string, now: number): Promise<UsageSample[]> {
    const dir = join(geminiHome, 'tmp');
    const files = await recentFiles(
      dir,
      now - WEEK_MS,
      (name) => name.startsWith('session-') && /\.jsonl?$/.test(name),
    );
    const seen = new Set<string>();
    const result: UsageSample[] = [];
    const live = new Set<string>();
    for (const file of files) {
      live.add(file.path);
      let entry = this.parsed.get(file.path);
      if (entry?.mtime !== file.mtime) {
        const text = await readFile(file.path, 'utf8').catch(() => '');
        // O formato antigo é um JSON só; o novo, uma linha por mudança.
        const samples = file.path.endsWith('.jsonl')
          ? text.split('\n').flatMap(parseGeminiLine)
          : parseGeminiLine(text.replace(/\r?\n/g, ' '));
        entry = { mtime: file.mtime, samples };
        this.parsed.set(file.path, entry);
      }
      for (const sample of entry.samples) {
        if (sample.id !== undefined) {
          if (seen.has(sample.id)) continue;
          seen.add(sample.id);
        }
        result.push({ ts: sample.ts, tokens: sample.tokens });
      }
    }
    for (const path of this.parsed.keys()) {
      if (path.startsWith(dir) && !live.has(path)) this.parsed.delete(path);
    }
    return result;
  }

  /** Percentual real que o Codex grava a cada resposta; vale o registro mais recente. */
  private async codexWindows(codexHome: string, now: number): Promise<ProviderWindows | undefined> {
    const files = await recentFiles(join(codexHome, 'sessions'), now - WEEK_MS);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(0, 3)) {
      const lines = (await readFile(file.path, 'utf8')).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const found = parseCodexLimits(lines[i] ?? '');
        if (found) return found;
      }
    }
    return undefined;
  }
}
