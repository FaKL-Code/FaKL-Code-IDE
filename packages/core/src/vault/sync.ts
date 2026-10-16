import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { l10n } from '@fakl/i18n';

import { git, run } from '../exec.js';

export interface SyncResult {
  readonly ok: boolean;
  /** Algo foi enviado ou recebido. */
  readonly changed: boolean;
  /** Notas em conflito: a remota ficou, a local foi salva ao lado. */
  readonly conflicts: readonly string[];
  readonly error?: string;
}

export interface VaultSyncOptions {
  readonly root: string;
  /** Nome desta máquina nas mensagens de commit e nas cópias de conflito. */
  readonly machine?: string;
  readonly clock?: () => Date;
}

const AUTHOR = ['-c', 'user.name=FaKL-Code', '-c', 'user.email=fakl-code@localhost'];

/** `nota.md` → `nota (conflito máquina).md`. */
export function conflictName(path: string, machine: string): string {
  const dot = path.toLowerCase().endsWith('.md') ? path.length - 3 : path.length;
  return `${path.slice(0, dot)} (conflito ${machine})${path.slice(dot)}`;
}

/**
 * Sincronização do vault por git (SDD 10.2): commit automático, `pull
 * --rebase` e `push`. O git mescla por linha; quando a mesma linha mudou nas
 * duas máquinas, fica a versão remota e a local vira `<nota> (conflito
 * <máquina>).md`, para nada se perder.
 */
export class VaultSync {
  private running: Promise<SyncResult> | undefined;
  private readonly machine: string;
  private readonly clock: () => Date;

  constructor(private readonly options: VaultSyncOptions) {
    this.machine = (options.machine ?? hostname()).replace(/[^\p{L}\p{N}_.-]/gu, '-');
    this.clock = options.clock ?? (() => new Date());
  }

  /** É um repositório git com remoto? */
  async enabled(): Promise<boolean> {
    const remotes = await git(['remote'], this.options.root).catch(() => '');
    return remotes.split('\n').includes('origin');
  }

  async hasLocalChanges(): Promise<boolean> {
    return (await git(['status', '--porcelain'], this.options.root).catch(() => '')) !== '';
  }

  /** Uma sincronização por vez; chamadas durante uma em andamento esperam a mesma. */
  sync(): Promise<SyncResult> {
    this.running ??= this.doSync().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async doSync(): Promise<SyncResult> {
    const cwd = this.options.root;
    try {
      if (!(await this.enabled())) {
        return {
          ok: false,
          changed: false,
          conflicts: [],
          error: l10n.t('the vault has no origin remote'),
        };
      }
      let changed = false;
      if (await this.hasLocalChanges()) {
        await git(['add', '-A'], cwd);
        const stamp = this.clock().toISOString().slice(0, 16).replace('T', ' ');
        await git([...AUTHOR, 'commit', '-q', '-m', `vault: ${this.machine} ${stamp}`], cwd);
        changed = true;
      }
      // symbolic-ref funciona também num clone vazio, ainda sem commits.
      const branch = await git(['symbolic-ref', '--short', 'HEAD'], cwd);
      const hasHead =
        (await run('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd })).code === 0;
      const fetched = await run('git', ['fetch', '-q', 'origin'], { cwd, timeoutMs: 60_000 });
      if (fetched.code !== 0) {
        return {
          ok: false,
          changed,
          conflicts: [],
          error: fetched.stderr.trim() || l10n.t('fetch failed'),
        };
      }
      const hasRemote =
        (await run('git', ['rev-parse', '--verify', '-q', `origin/${branch}`], { cwd })).code === 0;
      const conflicts: string[] = [];
      if (hasRemote && !hasHead) {
        // Máquina nova: só pega o que já está no remoto.
        await git(['checkout', '-q', '-B', branch, `origin/${branch}`], cwd);
        return { ok: true, changed: true, conflicts };
      }
      // Vault vazio dos dois lados: nada a enviar.
      if (!hasHead) return { ok: true, changed, conflicts };
      if (hasRemote) {
        const behind = await git(['rev-list', '--count', `HEAD..origin/${branch}`], cwd);
        if (behind !== '0') {
          changed = true;
          conflicts.push(...(await this.rebase(branch)));
        }
      }
      const ahead = hasRemote
        ? await git(['rev-list', '--count', `origin/${branch}..HEAD`], cwd)
        : '1';
      if (ahead !== '0') {
        const pushed = await run('git', ['push', '-q', '-u', 'origin', branch], {
          cwd,
          timeoutMs: 120_000,
        });
        if (pushed.code !== 0) {
          return {
            ok: false,
            changed,
            conflicts,
            error: pushed.stderr.trim() || l10n.t('push failed'),
          };
        }
        changed = true;
      }
      return { ok: true, changed, conflicts };
    } catch (error) {
      return {
        ok: false,
        changed: false,
        conflicts: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Rebase sobre o remoto resolvendo conflitos nota a nota. */
  private async rebase(branch: string): Promise<string[]> {
    const cwd = this.options.root;
    const env = { GIT_EDITOR: 'true' };
    const conflicts: string[] = [];
    let result = await run('git', [...AUTHOR, 'rebase', `origin/${branch}`], { cwd, env });
    for (let guard = 0; result.code !== 0 && guard < 100; guard++) {
      const files = (await git(['diff', '--name-only', '--diff-filter=U'], cwd))
        .split('\n')
        .filter(Boolean);
      if (files.length === 0) {
        await run('git', ['rebase', '--abort'], { cwd });
        throw new Error(
          l10n.t('vault rebase failed: {0}', (result.stderr || result.stdout).trim()),
        );
      }
      for (const file of files) {
        // No rebase, o estágio 3 é o commit local sendo reaplicado e o 2 é o remoto.
        const local = await run('git', ['show', `:3:${file}`], { cwd });
        if (local.code === 0) {
          const copy = conflictName(file, this.machine);
          await writeFile(join(cwd, copy), local.stdout);
          await git(['add', '--', copy], cwd);
        }
        const remote = await run('git', ['checkout', '--ours', '--', file], { cwd });
        if (remote.code === 0) await git(['add', '--', file], cwd);
        else await git(['rm', '-q', '--', file], cwd);
        conflicts.push(file);
      }
      result = await run('git', [...AUTHOR, 'rebase', '--continue'], { cwd, env });
    }
    return conflicts;
  }
}
