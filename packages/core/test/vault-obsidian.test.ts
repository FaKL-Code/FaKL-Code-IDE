import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureVaultGitignore, VAULT_IGNORE_MARKER, VaultSync } from '../src/index.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

describe('.obsidian fora do sync (RF-402)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-vobs-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'remoto.git')]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const clone = (name: string): string => {
    const path = join(dir, name);
    execFileSync('git', ['clone', '-q', join(dir, 'remoto.git'), path]);
    git(path, 'checkout', '-q', '-B', 'main');
    git(path, 'config', 'core.autocrlf', 'false');
    return path;
  };

  it('versiona as preferências e deixa o estado do editor de fora', async () => {
    const mac = clone('mac');
    await put(mac, 'Inbox/ideia.md', 'texto\n');
    for (const arquivo of [
      '.obsidian/app.json',
      '.obsidian/appearance.json',
      '.obsidian/core-plugins.json',
      '.obsidian/community-plugins.json',
      '.obsidian/hotkeys.json',
      '.obsidian/plugins/dataview/main.js',
      '.obsidian/workspace.json',
      '.obsidian/workspace-mobile.json',
      '.obsidian/cache/indice',
    ]) {
      await put(mac, arquivo, '{}\n');
    }
    expect(await new VaultSync({ root: mac, machine: 'mac' }).sync()).toMatchObject({ ok: true });
    const versionados = git(mac, 'ls-files').split('\n');
    expect(versionados).toEqual(
      expect.arrayContaining([
        '.gitignore',
        'Inbox/ideia.md',
        '.obsidian/app.json',
        '.obsidian/appearance.json',
        '.obsidian/core-plugins.json',
        '.obsidian/community-plugins.json',
        '.obsidian/hotkeys.json',
        '.obsidian/plugins/dataview/main.js',
      ]),
    );
    expect(versionados.some((f) => f.startsWith('.obsidian/workspace'))).toBe(false);
    expect(versionados.some((f) => f.startsWith('.obsidian/cache'))).toBe(false);
    // O arquivo continua no disco: o Obsidian não perde o layout.
    expect(existsSync(join(mac, '.obsidian/workspace.json'))).toBe(true);
  }, 30_000);

  it('tira do git o estado que um vault antigo já versionava, sem apagar do disco', async () => {
    const mac = clone('mac');
    await put(mac, '.obsidian/workspace.json', '{}\n');
    await put(mac, '.obsidian/app.json', '{}\n');
    git(mac, 'add', '-A');
    git(mac, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'antigo');
    await put(mac, 'Inbox/nova.md', 'x\n');
    await new VaultSync({ root: mac, machine: 'mac' }).sync();
    const versionados = git(mac, 'ls-files').split('\n');
    expect(versionados).not.toContain('.obsidian/workspace.json');
    expect(versionados).toContain('.obsidian/app.json');
    expect(existsSync(join(mac, '.obsidian/workspace.json'))).toBe(true);
  }, 30_000);

  it('não toca no que o usuário ignorou por conta própria', async () => {
    const mac = clone('mac');
    await put(mac, 'privado/segredo.md', 'x\n');
    git(mac, 'add', '-f', 'privado/segredo.md');
    git(mac, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'antigo');
    await put(mac, '.gitignore', 'privado/\n');
    await put(mac, 'Inbox/nova.md', 'x\n');
    await new VaultSync({ root: mac, machine: 'mac' }).sync();
    expect(git(mac, 'ls-files').split('\n')).toContain('privado/segredo.md');
  }, 30_000);
});

describe('.gitignore do vault', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-vign-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('cria o arquivo com o bloco comentado', async () => {
    expect(await ensureVaultGitignore(dir)).toBe(true);
    const text = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(text).toContain(VAULT_IGNORE_MARKER);
    expect(text).toContain('.obsidian/workspace*.json');
    expect(text).toContain('.obsidian/cache');
    expect(text).not.toContain('.obsidian/app.json');
    expect(text).not.toContain('plugins');
  });

  it('só acrescenta o que falta ao arquivo do usuário, sem reescrevê-lo', async () => {
    await writeFile(join(dir, '.gitignore'), '*.tmp\n/.obsidian/cache/\nprivado/');
    expect(await ensureVaultGitignore(dir)).toBe(true);
    const text = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(text.startsWith('*.tmp\n/.obsidian/cache/\nprivado/\n')).toBe(true);
    expect(text.match(/cache/g)).toHaveLength(1);
    expect(text).toContain('.obsidian/workspace*.json');
  });

  it('é idempotente', async () => {
    await ensureVaultGitignore(dir);
    expect(await ensureVaultGitignore(dir)).toBe(false);
  });

  it('respeita quem apagou linhas do bloco ou negou uma delas', async () => {
    await writeFile(join(dir, '.gitignore'), `${VAULT_IGNORE_MARKER}\n.trash/\n`);
    expect(await ensureVaultGitignore(dir)).toBe(false);
    await writeFile(join(dir, '.gitignore'), '!.obsidian/workspace*.json\n');
    await ensureVaultGitignore(dir);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).not.toMatch(/^\.obsidian\/workspace/m);
  });
});
