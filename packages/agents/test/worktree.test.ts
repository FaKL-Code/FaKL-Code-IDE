import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitWorktree, createWorktree, removeWorktree } from '../src/index.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('worktrees', () => {
  let dir: string;
  let repo: string;
  let home: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-wt-'));
    repo = join(dir, 'meu repo');
    home = join(dir, 'home');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.name', 'Teste');
    git(repo, 'config', 'user.email', 'teste@exemplo.com');
    // No Windows o git pode converter LF em CRLF no checkout.
    git(repo, 'config', 'core.autocrlf', 'false');
    await writeFile(join(repo, 'a.txt'), 'original\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'inicial');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('isola dois agentes no mesmo repositório', async () => {
    const one = await createWorktree({ repo, home, sessionId: 's1', taskId: 't1' });
    const two = await createWorktree({ repo, home, sessionId: 's2', taskId: 't1' });
    expect(one.path).toBe(join(home, '.fakl', 'worktrees', 'meu_repo', 's1'));
    expect(one.branch).toBe('fakl/t1/s1');

    await writeFile(join(one.path, 'a.txt'), 'do agente 1\n');
    expect(await readFile(join(two.path, 'a.txt'), 'utf8')).toBe('original\n');
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('original\n');
  });

  it('aguenta o maestro pedindo vários subagentes ao mesmo tempo', async () => {
    const parent = await createWorktree({ repo, home, sessionId: 'm', taskId: 't1' });
    await writeFile(join(parent.path, 'do-maestro.txt'), 'x\n');
    // Cada pedido faz commit no worktree do maestro e abre um worktree novo a partir dele.
    const children = await Promise.all(
      ['s1', 's2', 's3', 's4'].map(async (sessionId) => {
        await commitWorktree(parent, 'antes de delegar');
        return createWorktree({ repo, home, sessionId, taskId: 't1', base: parent.branch });
      }),
    );
    expect(new Set(children.map((c) => c.path)).size).toBe(4);
    expect(git(repo, 'branch', '--list', 'fakl/t1/*').split('\n')).toHaveLength(5);
    expect(await readFile(join(children[0]?.path ?? '', 'do-maestro.txt'), 'utf8')).toBe('x\n');
  });

  it('guarda o trabalho no branch ao remover o worktree', async () => {
    const wt = await createWorktree({ repo, home, sessionId: 's1' });
    expect(wt.branch).toBe('fakl/avulso/s1');
    await writeFile(join(wt.path, 'novo.txt'), 'feito\n');
    await removeWorktree(wt, 'trabalho da sessão s1');

    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, 'show', `${wt.branch}:novo.txt`)).toBe('feito');
    expect(git(repo, 'log', '-1', '--format=%s', wt.branch)).toBe('trabalho da sessão s1');
  });

  it('remove o worktree com um node_modules de caminhos longos', async () => {
    // No Windows o git recusava apagar ("Filename too long") e a pasta ficava.
    const wt = await createWorktree({ repo, home, sessionId: 's1' });
    await writeFile(join(wt.path, '.gitignore'), 'node_modules\n');
    let deep = join(wt.path, 'node_modules', '.pnpm');
    while (deep.length < 300) deep = join(deep, 'pacote-com-um-nome-comprido');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'index.js'), '');
    await removeWorktree(wt, 'trabalho');

    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain('s1');
  });

  it('salva o trabalho mesmo com hooks do repositório que falhariam', async () => {
    // Como o lefthook num worktree sem node_modules: o pre-commit e o
    // commit-msg recusam tudo.
    const hooks = join(dir, 'hooks');
    await mkdir(hooks, { recursive: true });
    for (const name of ['pre-commit', 'commit-msg']) {
      await writeFile(join(hooks, name), '#!/bin/sh\necho "prettier: not found" >&2\nexit 1\n');
      await chmod(join(hooks, name), 0o755);
    }
    git(repo, 'config', 'core.hooksPath', hooks);
    const wt = await createWorktree({ repo, home, sessionId: 's1', taskId: 't1' });
    await writeFile(join(wt.path, 'novo.txt'), 'feito');
    expect(await commitWorktree(wt, 'fakl: trabalho do maestro antes de delegar')).toBe(true);
    expect(git(repo, 'show', `${wt.branch}:novo.txt`)).toBe('feito');
  });

  it('não cria commit quando nada mudou', async () => {
    const wt = await createWorktree({ repo, home, sessionId: 's1' });
    expect(await commitWorktree(wt, 'nada')).toBe(false);
    expect(git(repo, 'rev-parse', wt.branch)).toBe(wt.base);
  });

  it('recusa pasta fora de um repositório git', async () => {
    await expect(createWorktree({ repo: home, home, sessionId: 's1' })).rejects.toThrow(
      /não é um repositório git/,
    );
  });
});
