import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { l10n } from '@fakl/i18n';

/** Worktree de uma sessão de agente (SDD 8.4). */
export interface Worktree {
  readonly path: string;
  readonly branch: string;
  /** Raiz do repositório de onde o worktree saiu. */
  readonly repoRoot: string;
  /** Commit de partida. */
  readonly base: string;
}

export interface CreateWorktreeOptions {
  /** Qualquer pasta dentro do repositório. */
  readonly repo: string;
  /** Pasta pessoal; os worktrees ficam em ~/.fakl/worktrees. */
  readonly home: string;
  readonly sessionId: string;
  /** Sem tarefa, a sessão é avulsa. */
  readonly taskId?: string;
  /** Branch ou commit de partida; por padrão, o HEAD do repositório. */
  readonly base?: string;
}

const AUTHOR_FALLBACK = ['-c', 'user.name=FaKL-Code', '-c', 'user.email=fakl-code@localhost'];

export class WorktreeError extends Error {
  override readonly name = 'WorktreeError';
}

function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // No Windows o git para nos 260 caracteres; o node_modules de um worktree passa disso.
      ['-c', 'core.longpaths=true', ...args],
      { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (error)
          reject(new WorktreeError(`git ${args[0] ?? ''}: ${(stderr || error.message).trim()}`));
        else resolve(stdout.trim());
      },
    );
  });
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Uma operação do git por vez em cada repositório ou worktree. O maestro pode
 * pedir dois subagentes ao mesmo tempo; dois `git add` ou `git worktree add`
 * juntos disputam o index.lock e um deles falha.
 */
function exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/** Se a pasta está dentro de um repositório git com pelo menos um commit. */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', 'HEAD^{commit}'], path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cria `~/.fakl/worktrees/<repo>/<sessão>` num branch
 * `fakl/<tarefa>/<sessão>`, para dois agentes no mesmo repositório não
 * mexerem nos arquivos um do outro (RF-105).
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  let repoRoot: string;
  try {
    repoRoot = await git(['rev-parse', '--show-toplevel'], options.repo);
  } catch {
    throw new WorktreeError(l10n.t('{0} is not a git repository', options.repo));
  }
  const base = await git(['rev-parse', '--verify', `${options.base ?? 'HEAD'}^{commit}`], repoRoot);
  const repoName = basename(repoRoot).replace(/[^A-Za-z0-9_.-]/g, '_');
  const path = join(options.home, '.fakl', 'worktrees', repoName, options.sessionId);
  const branch = `fakl/${options.taskId ?? 'avulso'}/${options.sessionId}`;
  await exclusive(repoRoot, () => git(['worktree', 'add', '-b', branch, path, base], repoRoot));
  return { path, branch, repoRoot, base };
}

/**
 * Faz commit de tudo o que mudou no worktree. Devolve se havia mudança.
 *
 * É um ponto de salvamento do Core (antes de delegar, integrar ou remover), não
 * uma entrega: por isso pula os hooks do repositório (`--no-verify`). Num
 * worktree recém-criado ainda não há node_modules, e um pre-commit que roda o
 * prettier ou um commit-msg com commitlint derrubava o spawn_agent com "erro
 * interno do Core". A entrega continua passando pelo run_checks e pelo PR.
 */
export function commitWorktree(worktree: Worktree, message: string): Promise<boolean> {
  return exclusive(worktree.path, () => commitNow(worktree, message));
}

async function commitNow(worktree: Worktree, message: string): Promise<boolean> {
  await git(['add', '-A'], worktree.path);
  const status = await git(['status', '--porcelain'], worktree.path);
  if (!status) return false;
  const hasAuthor = await git(['config', 'user.email'], worktree.path).then(
    (email) => email !== '',
    () => false,
  );
  await git(
    [...(hasAuthor ? [] : AUTHOR_FALLBACK), 'commit', '-q', '--no-verify', '-m', message],
    worktree.path,
  );
  return true;
}

/**
 * Guarda o trabalho no branch e apaga a pasta do worktree. O branch fica até
 * o usuário mesclar ou descartar.
 */
export async function removeWorktree(worktree: Worktree, message: string): Promise<void> {
  await commitWorktree(worktree, message);
  await exclusive(worktree.repoRoot, async () => {
    try {
      await git(['worktree', 'remove', '--force', worktree.path], worktree.repoRoot);
    } catch (error) {
      // O trabalho já está no branch; se o git não consegue apagar a pasta (um
      // arquivo preso, um caminho que ele não alcança), o Node apaga e o git esquece.
      await rm(worktree.path, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
        throw error;
      });
      await git(['worktree', 'prune'], worktree.repoRoot);
    }
  });
}

/**
 * Recria a pasta de um worktree já guardado, a partir do branch dele, para
 * retomar uma sessão depois de reiniciar o Core. Se a pasta ainda existe, não faz nada.
 */
export async function reopenWorktree(worktree: Worktree): Promise<void> {
  const present = await git(['rev-parse', '--show-toplevel'], worktree.path).then(
    () => true,
    () => false,
  );
  if (present) return;
  try {
    await exclusive(worktree.repoRoot, async () => {
      await git(['worktree', 'prune'], worktree.repoRoot);
      await git(['worktree', 'add', worktree.path, worktree.branch], worktree.repoRoot);
    });
  } catch (error) {
    throw new WorktreeError(
      l10n.t(
        'could not reopen the branch {0}: {1}',
        worktree.branch,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}
