import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyFiles,
  changedFiles,
  createWorktree,
  fileContent,
  rejectFiles,
  removeWorktree,
  type Worktree,
} from '../src/index.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('diff do agente', () => {
  let dir: string;
  let repo: string;
  let wt: Worktree;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-diff-'));
    repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.name', 'Teste');
    git(repo, 'config', 'user.email', 'teste@exemplo.com');
    git(repo, 'config', 'core.autocrlf', 'false');
    await writeFile(join(repo, 'a.txt'), 'um\ndois\ntrês\n');
    await writeFile(join(repo, 'b.txt'), 'apagar\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'inicial');
    wt = await createWorktree({ repo, home: join(dir, 'home'), sessionId: 's1' });
    await writeFile(join(wt.path, 'a.txt'), 'um\nDOIS\ntrês\n');
    await rm(join(wt.path, 'b.txt'));
    await writeFile(join(wt.path, 'novo.txt'), 'novo\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lista o que mudou, inclusive arquivos novos, sem mexer no índice do agente', async () => {
    const files = await changedFiles(wt);
    expect(files).toEqual([
      { path: 'a.txt', status: 'modificado', additions: 1, deletions: 1 },
      { path: 'b.txt', status: 'removido', additions: 0, deletions: 1 },
      { path: 'novo.txt', status: 'adicionado', additions: 1, deletions: 0 },
    ]);
    expect(git(wt.path, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('dá o conteúdo dos dois lados', async () => {
    expect((await fileContent(wt, 'a.txt', 'base'))?.toString()).toBe('um\ndois\ntrês\n');
    expect((await fileContent(wt, 'a.txt', 'agente'))?.toString()).toBe('um\nDOIS\ntrês\n');
    expect(await fileContent(wt, 'novo.txt', 'base')).toBeUndefined();
  });

  it('aplica arquivos escolhidos na pasta do usuário', async () => {
    const result = await applyFiles(wt, ['a.txt', 'novo.txt', 'b.txt']);
    expect(result).toEqual({ applied: ['a.txt', 'novo.txt', 'b.txt'], conflicts: [] });
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('um\nDOIS\ntrês\n');
    expect(await readFile(join(repo, 'novo.txt'), 'utf8')).toBe('novo\n');
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);
  });

  it('mescla com o que o usuário mudou no mesmo arquivo', async () => {
    await writeFile(join(repo, 'a.txt'), 'um\ndois\ntrês\nquatro\n');
    const result = await applyFiles(wt, ['a.txt']);
    expect(result.applied).toEqual(['a.txt']);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('um\nDOIS\ntrês\nquatro\n');
  });

  it('marca conflito quando as duas mudanças batem', async () => {
    await writeFile(join(repo, 'a.txt'), 'um\nDois do usuário\ntrês\n');
    const result = await applyFiles(wt, ['a.txt']);
    expect(result.conflicts).toEqual(['a.txt']);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toContain('<<<<<<<');
  });

  it('só com o que entra limpo deixa o arquivo em conflito como está', async () => {
    await writeFile(join(repo, 'a.txt'), 'um\nDois do usuário\ntrês\n');
    const result = await applyFiles(wt, ['a.txt', 'novo.txt'], { onlyClean: true });
    expect(result).toEqual({ applied: ['novo.txt'], conflicts: ['a.txt'] });
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('um\nDois do usuário\ntrês\n');
  });

  it('rejeitar volta o arquivo ao início no worktree', async () => {
    await rejectFiles(wt, ['a.txt', 'novo.txt']);
    expect(await readFile(join(wt.path, 'a.txt'), 'utf8')).toBe('um\ndois\ntrês\n');
    expect(existsSync(join(wt.path, 'novo.txt'))).toBe(false);
    expect((await changedFiles(wt)).map((f) => f.path)).toEqual(['b.txt']);
  });

  it('recusa caminhos fora do repositório', async () => {
    await expect(applyFiles(wt, ['../fora.txt'])).rejects.toThrow(/fora do repositório/);
    await expect(rejectFiles(wt, ['/etc/passwd'])).rejects.toThrow(/fora do repositório/);
  });

  it('continua funcionando pelo branch depois que o worktree é removido', async () => {
    await removeWorktree(wt, 'trabalho');
    expect((await changedFiles(wt)).map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'novo.txt']);
    expect((await fileContent(wt, 'novo.txt', 'agente'))?.toString()).toBe('novo\n');
    await applyFiles(wt, ['novo.txt']);
    expect(await readFile(join(repo, 'novo.txt'), 'utf8')).toBe('novo\n');
  });

  it('uma pasta que sobrou sem o .git não atrapalha: vale o branch', async () => {
    await removeWorktree(wt, 'trabalho');
    await mkdir(join(wt.path, '.next'), { recursive: true });
    expect((await changedFiles(wt)).map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'novo.txt']);
    const result = await applyFiles(wt, ['novo.txt']);
    expect(result.applied).toEqual(['novo.txt']);
    await expect(rejectFiles(wt, ['b.txt'])).resolves.toBeUndefined();
  });
});
