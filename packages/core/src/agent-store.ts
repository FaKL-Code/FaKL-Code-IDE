import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { l10n } from '@fakl/i18n';
import type {
  AgentOptionInfo,
  AgentRecoveryInfo,
  AgentState,
  AgentTranscriptEntry,
  AgentUsageInfo,
  AgentWorktreeInfo,
  ClaudeAccountSlot,
  PermissionPolicyName,
} from '@fakl/protocol';
import { AGENT_STATES, isClaudeAccountSlot, isPermissionMode } from '@fakl/protocol';

import { JsonlLog, readJson, writeJsonAtomic } from './store.js';

/**
 * Versão do formato do registro de sessão. Ao mudar o formato, some um passo em
 * `MIGRATIONS` (de N para N+1); registros de uma versão mais nova que a deste
 * Core (IDE antiga depois de um downgrade) ficam intactos no disco, sem serem lidos.
 */
export const SESSION_FORMAT = 1;

/** Itens da conversa guardados por sessão; os mais antigos saem primeiro. */
export const MAX_TRANSCRIPT_ENTRIES = 3000;
/** Teto do texto da conversa guardada por sessão, em caracteres. */
export const MAX_TRANSCRIPT_CHARS = 1_000_000;
/** Sessões encerradas há mais que isso são apagadas ao iniciar. */
export const RETENTION_DAYS = 30;
/** Máximo de sessões encerradas guardadas; as mais antigas saem primeiro. */
export const MAX_SESSIONS = 100;
const FLUSH_TEXT_MS = 1500;

/**
 * O que fica em `~/.fakl/data/agents/<sessão>.json`. Nunca entram segredos:
 * nem tokens do servidor MCP, nem variáveis de ambiente, nem o conteúdo dos
 * arquivos; o que o agente disse passou pelo `redact` do Core.
 */
export interface StoredSession {
  readonly versao: number;
  readonly id: string;
  readonly profileId: string;
  readonly taskId?: string;
  readonly retomada?: AgentRecoveryInfo;
  /** Preferência mantida também entre dois episódios de limite. */
  readonly retomadaAutomatica?: boolean;
  readonly nome: string;
  readonly titulo?: string;
  /** Pasta onde o agente trabalha (o worktree, quando há). */
  readonly cwd: string;
  readonly worktree?: AgentWorktreeInfo & { readonly repoRoot: string; readonly base: string };
  readonly permissoes: PermissionPolicyName;
  /** Opções oferecidas pelo agente com o valor escolhido (modelo, raciocínio, rápido...). */
  readonly opcoes: readonly AgentOptionInfo[];
  readonly estado: AgentState;
  /** Por que encerrou: `usuário`, `ide-fechando`, `interrompida` (o Core caiu) etc. */
  readonly motivo?: string;
  /** Id da sessão no agente (ACP), para `session/load` ou `session/resume`. */
  readonly acpSessionId?: string;
  /** Regras e contexto do início da conversa, para recriar a sessão. */
  readonly systemPrompt?: string;
  /** Conversa simples, sem servidores MCP; a retomada também abre sem eles. */
  readonly conversa?: boolean;
  /** Conta do Claude da sessão (ADR 0027); sem ela, a retomada usa a conta ativa. */
  readonly contaClaude?: ClaudeAccountSlot;
  readonly usage: AgentUsageInfo;
  readonly criadoEm: string;
  readonly atualizadoEm: string;
}

type Migration = (record: Record<string, unknown>) => Record<string, unknown>;

/** Passos de migração, de `versao` N para N+1. Vazio enquanto só existe a versão 1. */
const MIGRATIONS: Readonly<Record<number, Migration>> = {};

const ZERO_USAGE: AgentUsageInfo = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Lê um registro de qualquer versão antiga; `undefined` se for inválido ou de uma versão futura. */
export function migrateRecord(raw: unknown): StoredSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  let record = raw as Record<string, unknown>;
  let version = typeof record.versao === 'number' ? record.versao : 1;
  if (version > SESSION_FORMAT) return undefined;
  while (version < SESSION_FORMAT) {
    const step = MIGRATIONS[version];
    if (!step) return undefined;
    record = step(record);
    version++;
  }
  const { id, profileId, nome, cwd, estado } = record;
  if (
    typeof id !== 'string' ||
    typeof profileId !== 'string' ||
    typeof nome !== 'string' ||
    typeof cwd !== 'string' ||
    !AGENT_STATES.includes(estado as AgentState)
  ) {
    return undefined;
  }
  const now = new Date().toISOString();
  const { contaClaude, taskId, retomada, retomadaAutomatica, ...rest } = record;
  const recovery =
    typeof retomada === 'object' && retomada !== null
      ? (retomada as Record<string, unknown>)
      : undefined;
  const validRecovery: AgentRecoveryInfo | undefined =
    recovery?.motivo === 'limite-sessao' &&
    typeof recovery.mensagem === 'string' &&
    typeof recovery.automatica === 'boolean'
      ? {
          motivo: 'limite-sessao',
          mensagem: recovery.mensagem,
          automatica: recovery.automatica,
          ...(typeof recovery.retomarEm === 'string' &&
          Number.isFinite(Date.parse(recovery.retomarEm))
            ? { retomarEm: recovery.retomarEm }
            : {}),
        }
      : undefined;
  return {
    ...(rest as unknown as StoredSession),
    ...(isClaudeAccountSlot(contaClaude) ? { contaClaude } : {}),
    ...(typeof taskId === 'string' && taskId ? { taskId } : {}),
    ...(validRecovery ? { retomada: validRecovery } : {}),
    ...(typeof retomadaAutomatica === 'boolean' ? { retomadaAutomatica } : {}),
    versao: SESSION_FORMAT,
    permissoes: isPermissionMode(record.permissoes) ? record.permissoes : 'perguntar',
    opcoes: Array.isArray(record.opcoes) ? (record.opcoes as AgentOptionInfo[]) : [],
    usage: (record.usage as AgentUsageInfo | undefined) ?? ZERO_USAGE,
    criadoEm: typeof record.criadoEm === 'string' ? record.criadoEm : now,
    atualizadoEm: typeof record.atualizadoEm === 'string' ? record.atualizadoEm : now,
  };
}

/** Corta a conversa nos limites de tamanho, tirando os itens mais antigos. */
export function trimTranscript(
  entries: readonly AgentTranscriptEntry[],
  maxEntries = MAX_TRANSCRIPT_ENTRIES,
  maxChars = MAX_TRANSCRIPT_CHARS,
): AgentTranscriptEntry[] {
  const kept = entries.length > maxEntries ? entries.slice(-maxEntries) : [...entries];
  const size = (entry: AgentTranscriptEntry): number => JSON.stringify(entry).length;
  let chars = kept.reduce((total, entry) => total + size(entry), 0);
  // Tira do começo até caber; a última entrada fica sempre.
  let drop = 0;
  for (const entry of kept) {
    if (chars <= maxChars || drop >= kept.length - 1) break;
    chars -= size(entry);
    drop++;
  }
  kept.splice(0, drop);
  return kept;
}

/** Máximo de caracteres do histórico entregue ao agente ao recriar uma sessão. */
const HISTORY_CHARS = 12_000;

/**
 * A conversa em texto, para o agente recomeçar de onde parou quando não dá
 * para retomar a sessão dele. Fica só o final, que é o que importa.
 */
export function historyContext(
  entries: readonly AgentTranscriptEntry[],
  maxChars = HISTORY_CHARS,
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.t === 'user') {
      lines.push(l10n.t('User: {0}', entry.text));
    } else if (entry.topic === 'agent.output') {
      const data = entry.data as { kind?: string; text?: string };
      if (data.kind === 'message' && data.text) lines.push(l10n.t('Agent: {0}', data.text));
    }
  }
  if (lines.length === 0) return '';
  let body = lines.join('\n\n');
  if (body.length > maxChars) body = `…${body.slice(-maxChars)}`;
  return [
    l10n.t(
      "This conversation already existed and was resumed after the IDE restarted or the agent's account changed; the agent's previous session could not be loaded. What was said so far (use it as context, without repeating it):",
    ),
    body,
  ].join('\n\n');
}

interface PendingText {
  readonly kind: 'message' | 'thought';
  text: string;
  readonly ts: string;
  timer: NodeJS.Timeout;
}

export interface AgentSessionStoreOptions {
  /** Pasta `~/.fakl/data/agents`. */
  readonly dir: string;
  readonly log?: (message: string) => void;
}

/**
 * Sessões de agente em disco (ADR 0022, sobre o ADR 0007): um documento JSON
 * por sessão, gravado de forma atômica, e a conversa em JSON Lines. O texto do
 * agente chega em pedaços; pedaços seguidos viram um item só.
 */
export class AgentSessionStore {
  private readonly logs = new Map<string, JsonlLog<AgentTranscriptEntry>>();
  private readonly counts = new Map<string, number>();
  private readonly pending = new Map<string, PendingText>();

  constructor(private readonly options: AgentSessionStoreOptions) {}

  private recordPath(id: string): string {
    return join(this.options.dir, `${id}.json`);
  }

  private log(id: string): JsonlLog<AgentTranscriptEntry> {
    let log = this.logs.get(id);
    if (!log) {
      log = new JsonlLog<AgentTranscriptEntry>(join(this.options.dir, `${id}.jsonl`));
      this.logs.set(id, log);
    }
    return log;
  }

  /** Todos os registros válidos, e a retenção aplicada (sessões antigas ou em excesso saem). */
  async load(now = Date.now()): Promise<StoredSession[]> {
    const names = await readdir(this.options.dir).catch(() => [] as string[]);
    const records: StoredSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = migrateRecord(await readJson<unknown>(join(this.options.dir, name)));
      if (record) records.push(record);
      else this.options.log?.(l10n.t('session {0} ignored: invalid format or newer version', name));
    }
    records.sort((a, b) => a.atualizadoEm.localeCompare(b.atualizadoEm));
    const cutoff = now - RETENTION_DAYS * 86_400_000;
    const final = records.filter(
      (r) => !r.taskId && !r.retomada && (r.estado === 'parado' || r.estado === 'concluído'),
    );
    const excess = Math.max(0, final.length - MAX_SESSIONS);
    const expired = new Set(
      final
        .filter((r, index) => index < excess || Date.parse(r.atualizadoEm) < cutoff)
        .map((r) => r.id),
    );
    for (const id of expired) await this.remove(id);
    return records.filter((r) => !expired.has(r.id));
  }

  save(record: StoredSession): Promise<void> {
    return writeJsonAtomic(this.recordPath(record.id), record);
  }

  /** Acrescenta a mensagem do usuário na conversa. */
  user(id: string, text: string): void {
    this.append(id, { t: 'user', text, ts: new Date().toISOString() });
  }

  /** Acrescenta um evento `agent.*`; pedaços de texto seguidos viram um item só. */
  event(id: string, topic: string, data: unknown): void {
    if (topic === 'agent.output') {
      const output = data as { kind?: string; text?: string };
      if ((output.kind === 'message' || output.kind === 'thought') && output.text) {
        this.pushText(id, output.kind, output.text);
        return;
      }
    }
    this.append(id, { t: 'event', topic, data, ts: new Date().toISOString() });
  }

  private pushText(id: string, kind: 'message' | 'thought', text: string): void {
    const current = this.pending.get(id);
    if (current?.kind === kind) {
      current.text += text;
      return;
    }
    this.flushText(id);
    const timer = setTimeout(() => {
      this.flushText(id);
    }, FLUSH_TEXT_MS);
    timer.unref();
    this.pending.set(id, { kind, text, ts: new Date().toISOString(), timer });
  }

  private flushText(id: string): void {
    const current = this.pending.get(id);
    if (!current) return;
    clearTimeout(current.timer);
    this.pending.delete(id);
    this.write(id, {
      t: 'event',
      topic: 'agent.output',
      data: { kind: current.kind, text: current.text },
      ts: current.ts,
    });
  }

  private append(id: string, entry: AgentTranscriptEntry): void {
    this.flushText(id);
    this.write(id, entry);
  }

  private write(id: string, entry: AgentTranscriptEntry): void {
    const count = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, count);
    this.log(id)
      .append(entry)
      .catch((error: unknown) => {
        this.options.log?.(
          l10n.t('could not write the conversation of {0}: {1}', id, String(error)),
        );
      });
    // Passou do limite com folga: compacta em segundo plano.
    if (count > MAX_TRANSCRIPT_ENTRIES * 1.2) void this.compact(id);
  }

  /** A conversa guardada, já dentro dos limites. */
  async transcript(id: string): Promise<AgentTranscriptEntry[]> {
    this.flushText(id);
    const log = this.log(id);
    await log.flush().catch(() => undefined);
    const entries = await log.readAll();
    this.counts.set(id, entries.length);
    return trimTranscript(entries);
  }

  /** Reescreve a conversa só com o que cabe nos limites. */
  async compact(id: string): Promise<void> {
    this.flushText(id);
    const log = this.log(id);
    await log.flush().catch(() => undefined);
    const entries = await log.readAll();
    const kept = trimTranscript(entries);
    this.counts.set(id, kept.length);
    if (kept.length !== entries.length) await log.replace(kept);
  }

  /** Apaga a sessão e a conversa do disco. */
  async remove(id: string): Promise<void> {
    const pending = this.pending.get(id);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(id);
    await this.logs
      .get(id)
      ?.flush()
      .catch(() => undefined);
    this.logs.delete(id);
    this.counts.delete(id);
    await rm(this.recordPath(id), { force: true });
    await rm(join(this.options.dir, `${id}.jsonl`), { force: true });
  }

  /** Espera tudo o que foi pedido para gravar. */
  async flush(): Promise<void> {
    for (const id of [...this.pending.keys()]) this.flushText(id);
    await Promise.all([...this.logs.values()].map((log) => log.flush().catch(() => undefined)));
  }
}
