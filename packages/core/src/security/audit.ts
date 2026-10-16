import { createHash } from 'node:crypto';

import { JsonlLog } from '../store.js';
import { ulid } from '../ulid.js';
import { objectParams, type Router } from '../rpc/router.js';

/** Uma linha da auditoria (SDD 14.4). */
export interface AuditEntry {
  readonly id: string;
  readonly ts: string;
  /** Quem agiu: `ide`, `cli`, `remote:<aparelho>` ou o id da sessão do agente. */
  readonly ator: string;
  /** Ex.: `ssh.exec`, `github.prs.create`, `hostinger.dns.upsert`, `remote.pair`. */
  readonly acao: string;
  readonly alvo?: string;
  readonly detalhes?: Readonly<Record<string, unknown>>;
  readonly resultado: 'ok' | 'erro' | 'recusado' | 'negado' | 'aprovado';
  /** Hash da entrada anterior; a primeira usa 64 zeros. */
  readonly anterior: string;
  /** sha256 da entrada sem este campo. */
  readonly hash: string;
}

export type AuditInput = Omit<AuditEntry, 'id' | 'ts' | 'anterior' | 'hash'>;

const GENESIS = '0'.repeat(64);

function digest(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

/** Resultado de `audit.verify`: onde a corrente quebrou, se quebrou. */
export interface AuditVerification {
  readonly ok: boolean;
  readonly entradas: number;
  readonly quebraEm?: string;
}

export function verifyChain(entries: readonly AuditEntry[]): AuditVerification {
  let previous = GENESIS;
  for (const entry of entries) {
    const { hash, ...rest } = entry;
    if (entry.anterior !== previous || digest(rest) !== hash) {
      return { ok: false, entradas: entries.length, quebraEm: entry.id };
    }
    previous = hash;
  }
  return { ok: true, entradas: entries.length };
}

/**
 * Auditoria só de inserção, encadeada por hash (SDD 14.4): alterar ou apagar
 * uma linha antiga quebra a corrente, e `audit.verify` aponta onde.
 */
export class AuditLog {
  private readonly log: JsonlLog<AuditEntry> | undefined;
  private last = GENESIS;
  private readonly recent: AuditEntry[] = [];
  private loaded: Promise<void> | undefined;

  constructor(
    path: string | undefined,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.log = path ? new JsonlLog<AuditEntry>(path) : undefined;
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      const entries = (await this.log?.readAll()) ?? [];
      const tail = entries.at(-1);
      if (tail) this.last = tail.hash;
      this.recent.push(...entries.slice(-500));
    })();
    return this.loaded;
  }

  /** Acrescenta uma entrada; espera o arquivo, para a corrente seguir a ordem. */
  async record(input: AuditInput): Promise<AuditEntry> {
    await this.load();
    const base = {
      id: ulid(),
      ts: this.clock().toISOString(),
      ...input,
      anterior: this.last,
    };
    const entry: AuditEntry = { ...base, hash: digest(base) };
    this.last = entry.hash;
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    await this.log?.append(entry);
    return entry;
  }

  async verify(): Promise<AuditVerification> {
    await this.log?.flush();
    return verifyChain(this.log ? await this.log.readAll() : this.recent);
  }

  flush(): Promise<void> {
    return this.log?.flush() ?? Promise.resolve();
  }

  register(router: Router): void {
    router.register('audit.list', async (params) => {
      await this.load();
      const p = params === undefined ? {} : objectParams(params);
      const limit = typeof p.limite === 'number' && p.limite > 0 ? Math.min(p.limite, 500) : 100;
      const acao = typeof p.acao === 'string' ? p.acao : undefined;
      return this.recent
        .filter((entry) => !acao || entry.acao.startsWith(acao))
        .slice(-limit)
        .reverse();
    });
    router.register('audit.verify', () => this.verify());
  }
}
