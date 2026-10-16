import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

import { l10n } from '@fakl/i18n';

import type { Worktree } from './worktree.js';

/** Arquivo que o agente mudou em relação ao commit de partida. */
export interface ChangedFile {
  readonly path: string;
  readonly status: 'adicionado' | 'modificado' | 'removido';
  /** Linhas acrescentadas e removidas; ausentes em arquivo binário. */
  readonly additions?: number;
  readonly deletions?: number;
}

export interface ApplyResult {
  readonly applied: readonly string[];
  /** Aplicados com conflito: o arquivo ficou com marcadores para resolver. */
  readonly conflicts: readonly string[];
}

export class DiffError extends Error {
  override readonly name = 'DiffError';
}

interface GitOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
}

/** Caminho relativo ao repositório, sem sair dele. */
function checkPath(path: string): string {
  const normal = normalize(path);
  if (
    isAbsolute(normal) ||
    normal === '..' ||
    normal.startsWith(`..${sep}`) ||
    normal.startsWith('../')
  ) {
    throw new DiffError(l10n.t('path outside the repository: {0}', path));
  }
  return path;
}

function git(args: readonly string[], options: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else {
        const message = Buffer.concat(err).toString('utf8').trim();
        reject(
          new DiffError(
            `git ${args[0] ?? ''}: ${message || l10n.t('exited with {0}', String(code))}`,
          ),
        );
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function gitBuffer(args: readonly string[], cwd: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve(error ? undefined : stdout);
      },
    );
  });
}

/**
 * Commit com o estado atual do trabalho do agente. Com o worktree vivo, usa um
 * índice temporário para não mexer no que o agente deixou preparado; sem ele,
 * é a ponta do branch, onde o trabalho foi guardado ao terminar.
 */
export async function snapshot(worktree: Worktree): Promise<string> {
  if (!existsSync(worktree.path)) {
    return (
      await git(['rev-parse', `${worktree.branch}^{commit}`], { cwd: worktree.repoRoot })
    ).trim();
  }
  const dir = await mkdtemp(join(tmpdir(), 'fakl-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    await git(['read-tree', 'HEAD'], { cwd: worktree.path, env });
    await git(['add', '-A'], { cwd: worktree.path, env });
    const tree = (await git(['write-tree'], { cwd: worktree.path, env })).trim();
    const head = (await git(['rev-parse', 'HEAD'], { cwd: worktree.path })).trim();
    return (
      await git(
        ['commit-tree', tree, '-p', head, '-m', l10n.t('fakl: current state of the agent')],
        {
          cwd: worktree.path,
          env: {
            GIT_AUTHOR_NAME: 'FaKL-Code',
            GIT_AUTHOR_EMAIL: 'fakl-code@localhost',
            GIT_COMMITTER_NAME: 'FaKL-Code',
            GIT_COMMITTER_EMAIL: 'fakl-code@localhost',
          },
        },
      )
    ).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Arquivos que mudaram entre o commit de partida e o estado do agente. */
export async function changedFiles(worktree: Worktree): Promise<ChangedFile[]> {
  const head = await snapshot(worktree);
  const cwd = worktree.repoRoot;
  const [names, stats] = await Promise.all([
    git(['diff', '--name-status', '--no-renames', '-z', worktree.base, head], { cwd }),
    git(['diff', '--numstat', '--no-renames', '-z', worktree.base, head], { cwd }),
  ]);

  const counts = new Map<string, { additions?: number; deletions?: number }>();
  // numstat -z: "<add>\t<del>\t<caminho>\0"; binário vem como "-\t-".
  for (const entry of stats.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry);
    if (!match?.[3]) continue;
    const [, add, del, path] = match;
    counts.set(
      path,
      add === '-' || del === '-' ? {} : { additions: Number(add), deletions: Number(del) },
    );
  }

  const files: ChangedFile[] = [];
  // name-status -z: "<status>\0<caminho>\0".
  const parts = names.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i];
    const path = parts[i + 1];
    if (!code || !path) continue;
    const status = code.startsWith('A')
      ? 'adicionado'
      : code.startsWith('D')
        ? 'removido'
        : 'modificado';
    files.push({ path, status, ...counts.get(path) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Conteúdo do arquivo no commit de partida ou no estado do agente; `undefined` se não existe. */
export async function fileContent(
  worktree: Worktree,
  path: string,
  side: 'base' | 'agente',
): Promise<Buffer | undefined> {
  checkPath(path);
  const rev = side === 'base' ? worktree.base : await snapshot(worktree);
  return gitBuffer(['show', `${rev}:${path}`], worktree.repoRoot);
}

/**
 * Aplica as mudanças do agente nesses arquivos na pasta do usuário (a cópia de
 * trabalho de onde o worktree saiu). Quando o usuário também mexeu no arquivo,
 * mescla em três vias com `git merge-file` e deixa os conflitos marcados, sem
 * mexer no índice do usuário. Com `onlyClean`, esses arquivos ficam como estão.
 */
export async function applyFiles(
  worktree: Worktree,
  paths: readonly string[],
  options: {
    /** Não grava os arquivos que dariam conflito; eles voltam em `conflicts` intactos. */
    readonly onlyClean?: boolean;
  } = {},
): Promise<ApplyResult> {
  const head = await snapshot(worktree);
  const cwd = worktree.repoRoot;
  const applied: string[] = [];
  const conflicts: string[] = [];
  for (const path of paths.map(checkPath)) {
    const target = join(cwd, path);
    const [base, agent, current] = await Promise.all([
      gitBuffer(['show', `${worktree.base}:${path}`], cwd),
      gitBuffer(['show', `${head}:${path}`], cwd),
      readFile(target).catch(() => undefined),
    ]);
    const untouched = current === undefined ? base === undefined : base?.equals(current) === true;

    if (agent === undefined) {
      // O agente apagou o arquivo.
      if (untouched || current === undefined) {
        await rm(target, { force: true });
        applied.push(path);
      } else {
        conflicts.push(path);
      }
      continue;
    }
    if (untouched || current === undefined || current.equals(agent)) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, agent);
      applied.push(path);
      continue;
    }
    if (isBinary(agent) || isBinary(current) || (base !== undefined && isBinary(base))) {
      conflicts.push(path);
      continue;
    }
    const merged = await mergeText(current, base ?? Buffer.alloc(0), agent, cwd);
    if (merged.conflicts && options.onlyClean) {
      conflicts.push(path);
      continue;
    }
    await writeFile(target, merged.content);
    (merged.conflicts ? conflicts : applied).push(path);
  }
  return { applied, conflicts };
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

async function mergeText(
  current: Buffer,
  base: Buffer,
  agent: Buffer,
  cwd: string,
): Promise<{ content: Buffer; conflicts: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'fakl-merge-'));
  try {
    const files = ['seu', 'inicio', 'agente'].map((name) => join(dir, name));
    const [mine, start, theirs] = files as [string, string, string];
    await Promise.all([writeFile(mine, current), writeFile(start, base), writeFile(theirs, agent)]);
    // merge-file sai com o número de conflitos; a saída vai para stdout com -p.
    return await new Promise((resolve, reject) => {
      execFile(
        'git',
        [
          'merge-file',
          '-p',
          '-L',
          l10n.t('yours'),
          '-L',
          l10n.t('start'),
          '-L',
          l10n.t('agent'),
          mine,
          start,
          theirs,
        ],
        { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          const code = error && typeof error.code === 'number' ? error.code : 0;
          if (error && (code <= 0 || code > 127)) reject(new DiffError(error.message));
          else resolve({ content: stdout, conflicts: code > 0 });
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Descarta as mudanças do agente nesses arquivos. Com o worktree vivo, volta
 * os arquivos ao commit de partida; depois que o agente terminou, o branch
 * dele fica como está e a recusa vale para a aplicação.
 */
export async function rejectFiles(worktree: Worktree, paths: readonly string[]): Promise<void> {
  if (paths.length === 0 || !existsSync(worktree.path)) return;
  const cwd = worktree.path;
  for (const path of paths.map(checkPath)) {
    const inBase = await gitBuffer(['cat-file', '-e', `${worktree.base}:${path}`], cwd);
    if (inBase !== undefined) {
      await git(['checkout', worktree.base, '--', path], { cwd });
    } else {
      await rm(join(cwd, path), { force: true });
      await git(['rm', '-q', '--cached', '--ignore-unmatch', '--', path], { cwd }).catch(
        () => undefined,
      );
    }
  }
}
