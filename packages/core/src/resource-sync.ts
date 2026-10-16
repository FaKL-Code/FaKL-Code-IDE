import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { l10n } from '@fakl/i18n';
import type { ResourceInfo } from '@fakl/protocol';
import { stringify } from 'yaml';

import { isResourceName, splitFrontmatter } from './resources.js';
import { writeJsonAtomic } from './store.js';

/** Manifesto do que o FaKL instalou numa pasta de agente; o resto é do usuário. */
export const RESOURCE_MANIFEST = '.fakl-resources.json';

interface Manifest {
  agents: string[];
  skills: string[];
  /** Caminhos relativos copiados dentro de cada skill; somente estes podem ser apagados. */
  skillFiles: Record<string, string[]>;
}

/** O que sincronizar: agentes e skills da biblioteca. */
export interface SyncItems {
  readonly agents: readonly ResourceInfo[];
  readonly skills: readonly ResourceInfo[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readManifest(path: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { agents: [], skills: [], skillFiles: {} };
    }
    throw error;
  }
  try {
    const data = JSON.parse(raw) as Partial<Manifest>;
    const names = (value: unknown): string[] =>
      Array.isArray(value)
        ? [
            ...new Set(
              value.filter(
                (item): item is string => typeof item === 'string' && isResourceName(item),
              ),
            ),
          ]
        : [];
    const skills = names(data.skills);
    const rawFiles =
      data.skillFiles && typeof data.skillFiles === 'object' && !Array.isArray(data.skillFiles)
        ? data.skillFiles
        : {};
    const skillFiles: Record<string, string[]> = {};
    for (const name of skills) {
      const files = (rawFiles as Record<string, unknown>)[name];
      if (Array.isArray(files) && files.every(isManifestFile)) {
        skillFiles[name] = [...new Set(files)].sort();
      }
    }
    return { agents: names(data.agents), skills, skillFiles };
  } catch {
    return { agents: [], skills: [], skillFiles: {} };
  }
}

function isManifestFile(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes(':')) {
    return false;
  }
  const windowsDevice = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/i;
  return value
    .split('/')
    .every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !part.endsWith('.') &&
        !windowsDevice.test(part),
    );
}

/** `rm` no Windows pode falhar enquanto antivírus/indexador segura o arquivo. */
async function removeManaged(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function removeManagedFile(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EACCES' && code !== 'EBUSY' && code !== 'EPERM')) {
        throw error;
      }
      await delay(50 * (attempt + 1));
    }
  }
}

async function resourceFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await resourceFiles(join(root, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

async function sameRegularFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStat, rightStat] = await Promise.all([lstat(left), lstat(right)]);
    if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
    const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
    return leftContent.equals(rightContent);
  } catch {
    return false;
  }
}

/** Manifestos antigos só tinham a pasta; arquivos idênticos ainda podem ser reconhecidos como nossos. */
async function inferManagedFiles(dest: string, staged: string): Promise<string[]> {
  if (!(await exists(dest))) return [];
  const inferred: string[] = [];
  for (const relative of await resourceFiles(dest)) {
    const parts = relative.split('/');
    if (await sameRegularFile(join(dest, ...parts), join(staged, ...parts)))
      inferred.push(relative);
  }
  return inferred;
}

/** Leva para o staging tudo que não constava no manifesto anterior. */
async function preserveUserFiles(
  dest: string,
  staged: string,
  managed: ReadonlySet<string>,
): Promise<Set<string>> {
  const preserved = new Set<string>();
  if (!(await exists(dest))) return preserved;
  for (const relative of await resourceFiles(dest)) {
    if (managed.has(relative)) continue;
    const parts = relative.split('/');
    const source = join(dest, ...parts);
    const target = join(staged, ...parts);
    await removeManaged(target);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: false, errorOnExist: true });
    preserved.add(relative);
  }
  return preserved;
}

async function removeSkillFiles(
  dest: string,
  files: readonly string[],
  log?: (message: string) => void,
): Promise<string[]> {
  const failed: string[] = [];
  const directories = new Set<string>();
  for (const relative of files) {
    const parts = relative.split('/');
    for (let length = 1; length < parts.length; length++) {
      directories.add(join(dest, ...parts.slice(0, length)));
    }
    const path = join(dest, ...parts);
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        failed.push(relative);
        log?.(l10n.t('could not remove {0}: it is now a user folder', path));
      } else {
        await removeManagedFile(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed.push(relative);
        log?.(l10n.t('could not remove {0}: {1}', path, String(error)));
      }
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await rmdir(directory).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
        log?.(l10n.t('could not remove the empty folder {0}: {1}', directory, String(error)));
      }
    });
  }
  await rmdir(dest).catch(() => undefined);
  return failed;
}

/** Troca a entrada, não o conteúdo apontado por um symlink ou hardlink. */
async function replaceManaged(staged: string, dest: string): Promise<void> {
  try {
    await rename(staged, dest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code ?? '')) throw error;
    await removeManaged(dest);
    await rename(staged, dest);
  }
}

const syncing = new Map<string, Promise<void>>();

function targetKey(target: string): string {
  const absolute = resolve(target);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** Alias de modelo do Claude Code (`haiku`, `sonnet`, `opus`) a partir do bloco `fakl`. */
export function claudeModelAlias(info: ResourceInfo): string | undefined {
  for (const value of [info.modelo, info.perfil]) {
    const match = value ? /\b(?:claude-)?(haiku|sonnet|opus)\b/i.exec(value) : null;
    if (match?.[1]) return match[1].toLowerCase();
  }
  return undefined;
}

/** Agente da biblioteca no formato de subagente do Claude Code. */
export function claudeSubagent(info: ResourceInfo, content: string): string {
  const { body } = splitFrontmatter(content);
  const model = claudeModelAlias(info);
  const front = stringify({
    name: info.name,
    description: info.description || info.name,
    ...(model ? { model } : {}),
  });
  return `---\n${front}---\n\n${body.trimStart()}`;
}

/**
 * Agente da biblioteca no formato de subagente do Gemini CLI
 * (`~/.gemini/agents/<slug>.md`): o `name` aceita só letras minúsculas,
 * números, `-` e `_`, e o modelo só vai quando já é um modelo Gemini; sem
 * ele, o subagente herda o modelo da sessão.
 */
export function geminiSubagent(info: ResourceInfo, content: string): string {
  const { body } = splitFrontmatter(content);
  const model = [info.modelo, info.alternativa].find((value) => value && /^gemini-/i.test(value));
  const front = stringify({
    name: info.name.replace(/[^a-z0-9_-]/g, '-'),
    description: info.description || info.name,
    ...(model ? { model } : {}),
  });
  return `---\n${front}---\n\n${body.trimStart()}`;
}

/** Formato dos agentes numa pasta de configuração; sem formato, a pasta só recebe skills. */
export type AgentFormat = 'claude' | 'gemini';

const AGENT_FORMATS: Readonly<
  Record<AgentFormat, (info: ResourceInfo, content: string) => string>
> = {
  claude: claudeSubagent,
  gemini: geminiSubagent,
};

/** Uma pasta de configuração de CLI de agente que recebe a biblioteca. */
export interface SyncTarget {
  readonly dir: string;
  /** Formato dos agentes; ausente, a CLI não tem subagentes e recebe só as skills. */
  readonly agents?: AgentFormat;
}

/**
 * Onde cada CLI de agente lê skills e subagentes, a partir do provedor do
 * perfil. Provedor sem CLI conhecida (modelos locais, agentes ACP genéricos)
 * não recebe nada.
 *
 * - Claude Code: `<CLAUDE_CONFIG_DIR>` (padrão `~/.claude`), com `skills/<slug>/SKILL.md`
 *   e `agents/<slug>.md`.
 * - Codex: `<CODEX_HOME>` (padrão `~/.codex`), só `skills/<slug>/SKILL.md`.
 * - Gemini CLI: `<GEMINI_CLI_HOME>/.gemini` (padrão `~/.gemini`), com Agent Skills em
 *   `skills/<slug>/SKILL.md` e subagentes em `agents/<slug>.md`, os dois lidos no nível
 *   do usuário. Extensões (`extensions/`) e comandos TOML não servem: a extensão é um
 *   pacote por instalação e o comando é um atalho do usuário, não algo que o modelo aciona.
 */
export function providerSyncTarget(
  provedor: string,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): SyncTarget | undefined {
  switch (provedor) {
    case 'anthropic':
      return { dir: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), agents: 'claude' };
    case 'openai':
      return { dir: env.CODEX_HOME ?? join(home, '.codex') };
    case 'google':
      return { dir: join(env.GEMINI_CLI_HOME ?? home, '.gemini'), agents: 'gemini' };
    default:
      return undefined;
  }
}

/**
 * Copia os recursos da biblioteca para a pasta de configuração de um agente
 * (`<CLAUDE_CONFIG_DIR>`, `<CODEX_HOME>` ou `~/.gemini`): skills em
 * `skills/<slug>/` e agentes em `agents/<slug>.md`, no formato da CLI. O
 * manifesto guarda o que é nosso: só isso é atualizado ou apagado; arquivos do
 * usuário com o mesmo nome ficam como estão.
 */
async function syncResourcesNow(
  target: string,
  items: SyncItems,
  log: ((message: string) => void) | undefined,
  format: AgentFormat,
): Promise<void> {
  const manifestPath = join(target, RESOURCE_MANIFEST);
  const old = await readManifest(manifestPath);
  const next: Manifest = { agents: [], skills: [], skillFiles: {} };
  const protectedAgents = new Set<string>();
  const foreign = (path: string, kind: string, name: string): void => {
    log?.(l10n.t('{0} {1} not synced: {2} belongs to the user', kind, name, path));
  };

  for (const info of items.agents) {
    const dest = join(target, 'agents', `${info.name}.md`);
    const ours = old.agents.includes(info.name);
    if (!ours && (await exists(dest))) {
      foreign(dest, 'agente', info.name);
      continue;
    }
    try {
      const content = AGENT_FORMATS[format](info, await readFile(info.path, 'utf8'));
      await mkdir(dirname(dest), { recursive: true });
      if (ours) {
        const destination = await lstat(dest).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (destination?.isDirectory() && !destination.isSymbolicLink()) {
          foreign(dest, 'agente', info.name);
          protectedAgents.add(info.name);
          continue;
        }
        const current = await readFile(dest, 'utf8').catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (current !== content) {
          const stagingRoot = await mkdtemp(join(dirname(dest), `.${info.name}.fakl-`));
          try {
            const staged = join(stagingRoot, 'resource.md');
            await writeFile(staged, content, { flag: 'wx' });
            await replaceManaged(staged, dest);
          } finally {
            await removeManaged(stagingRoot).catch((error: unknown) => {
              log?.(l10n.t('could not clean {0}: {1}', stagingRoot, String(error)));
            });
          }
        }
      } else {
        try {
          await writeFile(dest, content, { flag: 'wx' });
        } catch (error) {
          if (await exists(dest)) {
            foreign(dest, 'agente', info.name);
            continue;
          }
          throw error;
        }
      }
      next.agents.push(info.name);
    } catch (error) {
      // Uma leitura/gravação transitória não transforma nossa cópia anterior
      // em obsoleta: mantenha-a no manifesto para não apagá-la logo abaixo.
      if (ours) next.agents.push(info.name);
      log?.(l10n.t('could not sync the agent {0}: {1}', info.name, String(error)));
    }
  }

  for (const info of items.skills) {
    const dest = join(target, 'skills', info.name);
    const ours = old.skills.includes(info.name);
    if (!ours && (await exists(dest))) {
      foreign(dest, 'skill', info.name);
      continue;
    }
    let stagingRoot: string | undefined;
    try {
      await mkdir(dirname(dest), { recursive: true });
      stagingRoot = await mkdtemp(join(dirname(dest), `.${info.name}.fakl-`));
      const staged = join(stagingRoot, 'resource');
      await cp(dirname(info.path), staged, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      const oldFiles = ours
        ? Object.hasOwn(old.skillFiles, info.name)
          ? (old.skillFiles[info.name] ?? [])
          : await inferManagedFiles(dest, staged)
        : [];
      const preserved = ours
        ? await preserveUserFiles(dest, staged, new Set(oldFiles))
        : new Set<string>();
      try {
        if (ours) await replaceManaged(staged, dest);
        else await rename(staged, dest);
      } catch (error) {
        if (!ours && (await exists(dest))) {
          foreign(dest, 'skill', info.name);
          continue;
        }
        throw error;
      }
      next.skills.push(info.name);
      next.skillFiles[info.name] = (await resourceFiles(dest)).filter(
        (relative) => !preserved.has(relative),
      );
    } catch (error) {
      if (ours) {
        next.skills.push(info.name);
        const oldSkillFiles = old.skillFiles[info.name];
        if (oldSkillFiles) next.skillFiles[info.name] = oldSkillFiles;
      }
      log?.(l10n.t('could not sync the skill {0}: {1}', info.name, String(error)));
    } finally {
      if (stagingRoot) {
        await removeManaged(stagingRoot).catch((error: unknown) => {
          log?.(l10n.t('could not clean {0}: {1}', String(stagingRoot), String(error)));
        });
      }
    }
  }

  // O que saiu da biblioteca sai também daqui, mas só se foi o FaKL quem pôs.
  for (const name of old.agents.filter(
    (n) => !next.agents.includes(n) && !protectedAgents.has(n),
  )) {
    const path = join(target, 'agents', `${name}.md`);
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        log?.(l10n.t('agent {0} not removed: {1} is now a user folder', name, path));
        continue;
      }
      await removeManagedFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      next.agents.push(name);
      log?.(l10n.t('could not remove the agent {0}: {1}', name, String(error)));
    }
  }
  for (const name of old.skills.filter((n) => !next.skills.includes(n))) {
    const files = old.skillFiles[name];
    // Manifesto antigo: sem a lista não é seguro apagar a pasta inteira.
    if (!files) continue;
    const failed = await removeSkillFiles(join(target, 'skills', name), files, log);
    if (failed.length > 0) {
      next.skills.push(name);
      next.skillFiles[name] = failed;
    }
  }

  next.agents = [...new Set(next.agents)].sort();
  next.skills = [...new Set(next.skills)].sort();
  if (next.agents.length === 0 && next.skills.length === 0) {
    await removeManaged(manifestPath).catch((error: unknown) => {
      log?.(l10n.t('could not remove {0}: {1}', manifestPath, String(error)));
    });
    return;
  }
  await writeJsonAtomic(manifestPath, next);
}

/**
 * Serializa por pasta-alvo até entre instâncias de `ResourceSync`. Isso evita
 * que duas sessões em paralelo intercalem remoção, cópia e manifesto.
 */
export function syncResources(
  target: string,
  items: SyncItems,
  log?: (message: string) => void,
  format: AgentFormat = 'claude',
): Promise<void> {
  const key = targetKey(target);
  const previous = syncing.get(key) ?? Promise.resolve();
  const next = previous.then(() => syncResourcesNow(target, items, log, format));
  const settled = next.catch(() => undefined);
  syncing.set(key, settled);
  void settled.then(() => {
    if (syncing.get(key) === settled) syncing.delete(key);
  });
  return next;
}

export interface ResourceSyncOptions {
  /** Recursos instalados agora. */
  readonly items: () => Promise<SyncItems>;
  readonly log?: (message: string) => void;
}

/**
 * Mantém as pastas dos agentes em dia com a biblioteca: sincroniza antes de
 * iniciar uma sessão e de novo quando a biblioteca muda, nas pastas já vistas
 * e nas dos provedores configurados que já existem (a CLI já foi usada).
 */
export class ResourceSync {
  private readonly targets = new Map<string, SyncTarget>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ResourceSyncOptions) {}

  /** Sincroniza uma pasta agora e a acompanha nas próximas mudanças. */
  sync(target: SyncTarget): Promise<void> {
    this.targets.set(targetKey(target.dir), target);
    return this.run([target]);
  }

  /**
   * A biblioteca mudou: atualiza as pastas já sincronizadas e as dos
   * provedores configurados. Pasta de provedor que ainda não existe fica de
   * fora: a CLI não foi instalada ou usada, e criar a pasta dela seria lixo.
   */
  async refresh(configured: readonly SyncTarget[] = []): Promise<void> {
    const all = new Map(this.targets);
    for (const target of configured) {
      const key = targetKey(target.dir);
      if (all.has(key) || !(await exists(target.dir).catch(() => false))) continue;
      all.set(key, target);
    }
    return this.run([...all.values()]);
  }

  private run(targets: readonly SyncTarget[]): Promise<void> {
    // Uma sincronização por vez: sessões que sobem juntas não disputam os arquivos.
    const next = this.queue.then(async () => {
      if (targets.length === 0) return;
      const items = await this.options.items();
      for (const target of targets) {
        await syncResources(
          target.dir,
          target.agents ? items : { agents: [], skills: items.skills },
          this.options.log,
          target.agents ?? 'claude',
        ).catch((error: unknown) => {
          this.options.log?.(
            l10n.t('could not sync resources in {0}: {1}', target.dir, String(error)),
          );
        });
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
