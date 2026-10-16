import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitError, parseJsonc, SettingsSync, systemGit, type SyncPaths } from '../src/index.js';
import { put, read, tempDir } from './helpers.js';

const git = systemGit(['user.name=Teste', 'user.email=teste@fakl.local', 'commit.gpgsign=false']);

describe('SettingsSync', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let remote: string;

  beforeEach(async () => {
    dir = await tempDir();
    remote = join(dir.path, 'remote.git');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  });
  afterEach(() => dir.cleanup());

  function machine(name: string): { paths: SyncPaths; sync: SettingsSync } {
    const base = join(dir.path, name);
    const paths = {
      userDir: join(base, 'User'),
      faklDir: join(base, '.fakl'),
      repoDir: join(base, 'sync'),
    };
    return { paths, sync: new SettingsSync(paths, git) };
  }

  it('leva settings, atalhos, snippets, perfis e extensões de uma máquina para outra', async () => {
    const mac = machine('mac');
    await put(
      join(mac.paths.userDir, 'settings.json'),
      '{\n  // tema\n  "workbench.colorTheme": "Dracula"\n}',
    );
    await put(join(mac.paths.userDir, 'keybindings.json'), '[{"key":"cmd+k","command":"x"}]');
    await put(join(mac.paths.userDir, 'snippets', 'ts.json'), '{}');
    await put(join(mac.paths.faklDir, 'profiles', 'claude.yaml'), 'id: claude\n');
    await put(join(mac.paths.faklDir, 'config.yaml'), 'limites: {}\n');

    const first = await mac.sync.sync({
      remoteUrl: remote,
      installedExtensions: ['golang.go'],
      machine: 'mac',
    });
    expect(first.pushed).toBe(true);
    expect(first.updatedLocal).toEqual([]);

    const win = machine('win');
    await put(join(win.paths.userDir, 'settings.json'), '{ "editor.fontSize": 15 }');
    const second = await win.sync.sync({
      remoteUrl: remote,
      installedExtensions: ['ms-python.python'],
    });

    expect(second.extensionsToInstall).toEqual(['golang.go']);
    expect(second.pushed).toBe(true);
    expect(parseJsonc(await read(join(win.paths.userDir, 'settings.json')))).toEqual({
      'workbench.colorTheme': 'Dracula',
      'editor.fontSize': 15,
    });
    expect(await read(join(win.paths.userDir, 'keybindings.json'))).toBe(
      '[{"key":"cmd+k","command":"x"}]',
    );
    expect(await read(join(win.paths.userDir, 'snippets', 'ts.json'))).toBe('{}');
    expect(await read(join(win.paths.faklDir, 'profiles', 'claude.yaml'))).toBe('id: claude\n');
    expect(await read(join(win.paths.faklDir, 'config.yaml'))).toBe('limites: {}\n');

    // A configuração local do Windows volta para o Mac na sincronização seguinte.
    const back = await mac.sync.sync({ remoteUrl: remote, installedExtensions: ['golang.go'] });
    expect(back.updatedLocal).toContain('settings.json');
    expect(back.extensionsToInstall).toEqual(['ms-python.python']);
    const macSettings = await read(join(mac.paths.userDir, 'settings.json'));
    expect(macSettings).toContain('// tema');
    expect(parseJsonc(macSettings)).toEqual({
      'workbench.colorTheme': 'Dracula',
      'editor.fontSize': 15,
    });
  });

  it('mescla mudanças das duas máquinas e propaga perfis apagados', async () => {
    const mac = machine('mac');
    const win = machine('win');
    const settings = '{\n    "a": 1,\n    "b": 1,\n    "c": 1,\n    "d": 1,\n    "e": 1\n}';
    await put(join(mac.paths.userDir, 'settings.json'), settings);
    await put(join(mac.paths.faklDir, 'profiles', 'velho.yaml'), 'id: velho\n');
    await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    await win.sync.sync({ remoteUrl: remote, installedExtensions: [] });

    await put(join(mac.paths.userDir, 'settings.json'), settings.replace('"a": 1', '"a": 2'));
    await put(join(win.paths.userDir, 'settings.json'), settings.replace('"e": 1', '"e": 3'));
    const { rm } = await import('node:fs/promises');
    await rm(join(win.paths.faklDir, 'profiles', 'velho.yaml'));

    await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    const merged = await win.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    expect(merged.updatedLocal).toEqual(['settings.json']);
    expect(parseJsonc(await read(join(win.paths.userDir, 'settings.json')))).toMatchObject({
      a: 2,
      e: 3,
    });

    const final = await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    expect(final.updatedLocal).toEqual(['settings.json', 'fakl/profiles/velho.yaml']);
    expect(parseJsonc(await read(join(mac.paths.userDir, 'settings.json')))).toMatchObject({
      a: 2,
      e: 3,
    });
  });

  it('em conflito na mesma linha, vale a máquina que sincroniza por último', async () => {
    const mac = machine('mac');
    const win = machine('win');
    await put(join(mac.paths.userDir, 'settings.json'), '{\n    "editor.fontSize": 14\n}');
    await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    await win.sync.sync({ remoteUrl: remote, installedExtensions: [] });

    await put(join(mac.paths.userDir, 'settings.json'), '{\n    "editor.fontSize": 16\n}');
    await put(join(win.paths.userDir, 'settings.json'), '{\n    "editor.fontSize": 18\n}');
    await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    await win.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });

    expect(parseJsonc(await read(join(mac.paths.userDir, 'settings.json')))).toEqual({
      'editor.fontSize': 18,
    });
  });

  it('mantém settings ignorados só na máquina', async () => {
    const mac = machine('mac');
    const win = machine('win');
    const ignoredSettings = ['terminal.integrated.shell.osx'];
    await put(
      join(mac.paths.userDir, 'settings.json'),
      '{ "terminal.integrated.shell.osx": "/bin/zsh", "x": 1 }',
    );
    await mac.sync.sync({ remoteUrl: remote, installedExtensions: [], ignoredSettings });

    const repoSettings = await read(join(mac.paths.repoDir, 'editor', 'settings.json'));
    expect(parseJsonc(repoSettings)).toEqual({ x: 1 });

    await win.sync.sync({ remoteUrl: remote, installedExtensions: [], ignoredSettings });
    expect(parseJsonc(await read(join(win.paths.userDir, 'settings.json')))).toEqual({ x: 1 });

    const again = await mac.sync.sync({
      remoteUrl: remote,
      installedExtensions: [],
      ignoredSettings,
    });
    expect(again.pushed).toBe(false);
    expect(again.updatedLocal).toEqual([]);
  });

  it('não envia nada quando nada mudou', async () => {
    const mac = machine('mac');
    await put(join(mac.paths.userDir, 'settings.json'), '{ "x": 1 }');
    await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    const again = await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });
    expect(again).toEqual({ pushed: false, updatedLocal: [], extensionsToInstall: [] });
  });

  it('preserva os fins de linha mesmo com core.autocrlf=true no git do usuário', async () => {
    const global = join(dir.path, 'gitconfig-windows');
    await put(global, '[core]\n\tautocrlf = true\n');
    const windowsGit = systemGit(
      ['user.name=Teste', 'user.email=teste@fakl.local', 'commit.gpgsign=false'],
      { GIT_CONFIG_GLOBAL: global },
    );

    const mac = machine('mac');
    await put(join(mac.paths.faklDir, 'profiles', 'claude.yaml'), 'id: claude\nmodelo: opus\n');
    await mac.sync.sync({ remoteUrl: remote, installedExtensions: [] });

    const base = join(dir.path, 'win');
    const paths = {
      userDir: join(base, 'User'),
      faklDir: join(base, '.fakl'),
      repoDir: join(base, 'sync'),
    };
    await new SettingsSync(paths, windowsGit).sync({ remoteUrl: remote, installedExtensions: [] });

    expect(await read(join(paths.faklDir, 'profiles', 'claude.yaml'))).toBe(
      'id: claude\nmodelo: opus\n',
    );
  });

  it('relata falhas do git com o comando', async () => {
    const mac = machine('mac');
    const error = await mac.sync
      .sync({ remoteUrl: join(dir.path, 'nao-existe.git'), installedExtensions: [] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toMatch(/git fetch/);
  });
});

describe('autenticação do git', () => {
  it('monta GIT_CONFIG_* com o cabeçalho do token', async () => {
    const { githubTokenEnv } = await import('../src/index.js');
    const env = githubTokenEnv('abc');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:abc').toString('base64')}`,
    );
  });

  it('o git do sistema enxerga a configuração passada por ambiente', async () => {
    const { gitConfigEnv } = await import('../src/index.js');
    const run = systemGit([], gitConfigEnv({ 'fakl.teste': 'ok' }));
    expect((await run(['config', 'fakl.teste'], process.cwd())).trim()).toBe('ok');
  });
});
