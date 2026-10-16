import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { missingExtensions, normalizeExtensionId, type ExtensionId } from './extensions.js';
import {
  mergeKeybindings,
  mergeSettingsText,
  parseJsonc,
  setTopLevelKeys,
  stringifyJson,
  type Keybinding,
  type Settings,
} from './jsonc.js';

/**
 * Sincronização de configurações entre máquinas por um repositório git
 * privado (RF-005). O repositório guarda o último estado combinado; o git faz
 * a mesclagem de três vias entre o que mudou aqui e o que mudou na outra
 * máquina desde a última sincronização.
 *
 * Layout do repositório:
 *   editor/settings.json      settings sem as chaves ignoradas
 *   editor/keybindings.json
 *   editor/snippets/
 *   editor/extensions.json    lista ordenada de ids
 *   fakl/config.yaml          configuração do FaKL Core (SDD 6.5)
 *   fakl/profiles/            perfis de agente
 */

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} falhou: ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/**
 * Executa o git do sistema, que já traz as credenciais configuradas.
 * `extraConfig` vai na linha de comando (`-c chave=valor`); valores sensíveis,
 * como cabeçalhos de autenticação, devem ir em `env` (ver `gitConfigEnv`), que
 * não aparece na lista de processos.
 */
export function systemGit(
  extraConfig: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
): GitRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      const full = [...extraConfig.flatMap((c) => ['-c', c]), ...args];
      const options = {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      };
      execFile('git', full, options, (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(args, stderr || error.message));
        } else {
          resolve(stdout);
        }
      });
    });
}

/** Configuração do git por variáveis de ambiente (git 2.31 ou mais novo). */
export function gitConfigEnv(entries: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  const pairs = Object.entries(entries);
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/** Autentica o git em https://github.com com um token, sem gravá-lo em disco. */
export function githubTokenEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return gitConfigEnv({ 'http.https://github.com/.extraheader': `AUTHORIZATION: basic ${basic}` });
}

export interface SyncPaths {
  /** Pasta `User` da FaKL-Code. */
  readonly userDir: string;
  /** ~/.fakl */
  readonly faklDir: string;
  /** Clone local do repositório de sync. */
  readonly repoDir: string;
}

export interface SyncOptions {
  readonly remoteUrl: string;
  readonly branch?: string;
  /** Settings que ficam só nesta máquina (caminhos, fontes, zoom). */
  readonly ignoredSettings?: readonly string[];
  /** Extensões instaladas agora nesta máquina. */
  readonly installedExtensions: readonly ExtensionId[];
  /** Nome da máquina na mensagem de commit. */
  readonly machine?: string;
}

export interface SyncResult {
  /** Houve mudança local enviada ao repositório. */
  readonly pushed: boolean;
  /** Arquivos locais atualizados com mudanças vindas de outra máquina. */
  readonly updatedLocal: string[];
  /** Extensões sincronizadas que faltam instalar aqui. */
  readonly extensionsToInstall: ExtensionId[];
}

const DEFAULT_BRANCH = 'main';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if ((await readText(path)) === content) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return true;
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

/** Espelha `from` em `to`: copia o que mudou e apaga o que sumiu. */
async function mirrorDir(from: string, to: string): Promise<string[]> {
  const changed: string[] = [];
  const source = await listFiles(from);
  const wanted = new Set(source);
  for (const file of source) {
    const content = await readFile(join(from, file), 'utf8');
    if (await writeIfChanged(join(to, file), content)) changed.push(file);
  }
  for (const file of await listFiles(to)) {
    if (!wanted.has(file)) {
      await rm(join(to, file));
      changed.push(file);
    }
  }
  return changed;
}

function withoutKeys(text: string, keys: readonly string[]): string {
  const settings = parseJsonc<Settings>(text, 'settings.json');
  const present = keys.filter((key) => key in settings);
  if (present.length === 0) return text;
  return setTopLevelKeys(text, Object.fromEntries(present.map((key) => [key, undefined])));
}

function withLocalKeys(
  remoteText: string,
  localText: string | undefined,
  keys: readonly string[],
): string {
  if (!localText || keys.length === 0) return remoteText;
  const local = parseJsonc<Settings>(localText, 'settings.json');
  const keep = Object.fromEntries(
    keys.filter((key) => key in local).map((key) => [key, local[key]]),
  );
  return Object.keys(keep).length === 0 ? remoteText : setTopLevelKeys(remoteText, keep);
}

export class SettingsSync {
  constructor(
    private readonly paths: SyncPaths,
    private readonly git: GitRunner = systemGit(),
  ) {}

  async sync(options: SyncOptions): Promise<SyncResult> {
    const branch = options.branch ?? DEFAULT_BRANCH;
    const ignored = options.ignoredSettings ?? [];
    const repo = this.paths.repoDir;

    await this.ensureRepo(options.remoteUrl, branch);
    const { hasRemote, firstSync } = await this.fetch(branch);

    if (firstSync) {
      // Primeira vez desta máquina num repositório que já tem dados: soma o
      // que só existe aqui ao que veio da outra máquina, sem sobrescrever.
      await this.adoptRemote(ignored);
    }
    const installed = options.installedExtensions.map(normalizeExtensionId);
    const exported = firstSync
      ? [...new Set([...installed, ...(await this.syncedExtensions())])]
      : installed;
    await this.exportLocal(ignored, exported);
    await this.git(['add', '--all'], repo);
    const status = await this.git(['status', '--porcelain'], repo);
    if (status.trim() !== '') {
      const machine = options.machine ?? hostname();
      await this.commit(`sync: ${machine} ${new Date().toISOString()}`);
    }

    if (hasRemote) {
      // Em conflito na mesma linha, vale a mudança desta máquina, que é a mais
      // recente. O resto das mudanças das duas máquinas é preservado.
      await this.git(['rebase', '-X', 'theirs', `origin/${branch}`], repo).catch(
        async (error: unknown) => {
          await this.git(['rebase', '--abort'], repo).catch(() => undefined);
          throw error;
        },
      );
    }

    const ahead = await this.aheadOfRemote(branch, hasRemote);
    if (ahead) {
      await this.git(['push', 'origin', `HEAD:${branch}`], repo);
    }

    const updatedLocal = await this.importToLocal(ignored);
    const wanted = await this.syncedExtensions();
    return {
      pushed: ahead,
      updatedLocal,
      extensionsToInstall: missingExtensions(options.installedExtensions, wanted),
    };
  }

  private async ensureRepo(remoteUrl: string, branch: string): Promise<void> {
    const repo = this.paths.repoDir;
    if (await exists(join(repo, '.git'))) {
      await this.git(['remote', 'set-url', 'origin', remoteUrl], repo);
    } else {
      await mkdir(repo, { recursive: true });
      await this.git(['init', '--quiet', `--initial-branch=${branch}`], repo);
      await this.git(['remote', 'add', 'origin', remoteUrl], repo);
    }
    // Os arquivos vão e voltam byte a byte. Com o core.autocrlf=true comum no
    // Windows, o git trocaria os fins de linha de quem sincroniza.
    await this.git(['config', 'core.autocrlf', 'false'], repo);
  }

  /** Busca o branch remoto e posiciona o clone nele na primeira vez. */
  private async fetch(branch: string): Promise<{ hasRemote: boolean; firstSync: boolean }> {
    const repo = this.paths.repoDir;
    await this.git(['fetch', '--quiet', 'origin'], repo);
    const remoteRef = await this.git(['ls-remote', '--heads', 'origin', branch], repo);
    if (remoteRef.trim() === '') return { hasRemote: false, firstSync: false };

    if (!(await this.hasHead())) {
      await this.git(['reset', '--hard', '--quiet', `origin/${branch}`], repo);
      return { hasRemote: true, firstSync: true };
    }
    return { hasRemote: true, firstSync: false };
  }

  private hasHead(): Promise<boolean> {
    return this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], this.paths.repoDir).then(
      () => true,
      () => false,
    );
  }

  /** Mescla settings e atalhos locais sobre os do repositório, sem sobrescrever. */
  private async adoptRemote(ignored: readonly string[]): Promise<void> {
    const { userDir, repoDir } = this.paths;
    const editor = join(repoDir, 'editor');

    const remoteSettings = await readText(join(editor, 'settings.json'));
    const localSettings = await readText(join(userDir, 'settings.json'));
    if (remoteSettings !== undefined && localSettings?.trim()) {
      const local = parseJsonc<Settings>(localSettings, 'settings.json');
      const merged = mergeSettingsText(
        withLocalKeys(remoteSettings, localSettings, ignored),
        local,
        {
          overwrite: false,
        },
      );
      await writeIfChanged(join(userDir, 'settings.json'), merged.text);
    }

    const remoteKeys = await readText(join(editor, 'keybindings.json'));
    const localKeys = await readText(join(userDir, 'keybindings.json'));
    if (remoteKeys?.trim() && localKeys?.trim()) {
      const { merged } = mergeKeybindings(
        parseJsonc<Keybinding[]>(remoteKeys, 'keybindings.json'),
        parseJsonc<Keybinding[]>(localKeys, 'keybindings.json'),
      );
      await writeIfChanged(join(userDir, 'keybindings.json'), stringifyJson(merged));
    }
  }

  private async aheadOfRemote(branch: string, hasRemote: boolean): Promise<boolean> {
    const repo = this.paths.repoDir;
    if (!(await this.hasHead())) return false;
    if (!hasRemote) return true;
    const count = await this.git(['rev-list', '--count', `origin/${branch}..HEAD`], repo);
    return Number.parseInt(count.trim(), 10) > 0;
  }

  private async commit(message: string): Promise<void> {
    const repo = this.paths.repoDir;
    const email = await this.git(['config', 'user.email'], repo).catch(() => '');
    // Numa máquina nova sem identidade no git, o commit ainda precisa sair.
    const identity =
      email.trim() === ''
        ? ['-c', 'user.name=FaKL-Code', '-c', 'user.email=sync@fakl-code.local']
        : [];
    await this.git([...identity, 'commit', '--quiet', '-m', message], repo);
  }

  private async exportLocal(
    ignored: readonly string[],
    extensions: readonly ExtensionId[],
  ): Promise<void> {
    const { userDir, faklDir, repoDir } = this.paths;
    const editor = join(repoDir, 'editor');

    const settings = await readText(join(userDir, 'settings.json'));
    if (settings !== undefined && settings.trim() !== '') {
      await writeIfChanged(join(editor, 'settings.json'), withoutKeys(settings, ignored));
    }
    const keybindings = await readText(join(userDir, 'keybindings.json'));
    if (keybindings !== undefined) {
      await writeIfChanged(join(editor, 'keybindings.json'), keybindings);
    }
    if (await exists(join(userDir, 'snippets'))) {
      await mirrorDir(join(userDir, 'snippets'), join(editor, 'snippets'));
    }
    await writeIfChanged(join(editor, 'extensions.json'), stringifyJson([...extensions].sort()));

    const config = await readText(join(faklDir, 'config.yaml'));
    if (config !== undefined) {
      await writeIfChanged(join(repoDir, 'fakl', 'config.yaml'), config);
    }
    if (await exists(join(faklDir, 'profiles'))) {
      await mirrorDir(join(faklDir, 'profiles'), join(repoDir, 'fakl', 'profiles'));
    }
  }

  private async importToLocal(ignored: readonly string[]): Promise<string[]> {
    const { userDir, faklDir, repoDir } = this.paths;
    const editor = join(repoDir, 'editor');
    const updated: string[] = [];

    const settings = await readText(join(editor, 'settings.json'));
    if (settings !== undefined) {
      const target = join(userDir, 'settings.json');
      const merged = withLocalKeys(settings, await readText(target), ignored);
      if (await writeIfChanged(target, merged)) updated.push('settings.json');
    }
    const keybindings = await readText(join(editor, 'keybindings.json'));
    if (
      keybindings !== undefined &&
      (await writeIfChanged(join(userDir, 'keybindings.json'), keybindings))
    ) {
      updated.push('keybindings.json');
    }
    // O repositório já contém o estado local (exportado antes do rebase), então
    // espelhá-lo de volta só traz o que mudou fora, inclusive arquivos apagados.
    // O git remove pastas vazias, por isso o espelho roda mesmo sem a pasta.
    for (const file of await mirrorDir(join(editor, 'snippets'), join(userDir, 'snippets'))) {
      updated.push(`snippets/${file}`);
    }

    const config = await readText(join(repoDir, 'fakl', 'config.yaml'));
    if (config !== undefined && (await writeIfChanged(join(faklDir, 'config.yaml'), config))) {
      updated.push('fakl/config.yaml');
    }
    for (const file of await mirrorDir(
      join(repoDir, 'fakl', 'profiles'),
      join(faklDir, 'profiles'),
    )) {
      updated.push(`fakl/profiles/${file}`);
    }
    return updated;
  }

  private async syncedExtensions(): Promise<ExtensionId[]> {
    const text = await readText(join(this.paths.repoDir, 'editor', 'extensions.json'));
    return text ? parseJsonc<ExtensionId[]>(text, 'extensions.json') : [];
  }
}
