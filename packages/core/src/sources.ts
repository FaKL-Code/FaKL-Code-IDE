import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { l10n } from '@fakl/i18n';
import type { AddResourceSourceParams, ResourceSource, ResourceSourceKind } from '@fakl/protocol';

import { run, type ExecResult } from './exec.js';
import { isResourceName, resourceSlug } from './resources.js';
import { objectParams, RpcError, stringParam, type Router } from './rpc/router.js';
import { writeJsonAtomic } from './store.js';

/** Uma fonte pronta para leitura: de onde vêm agentes, skills e modelos de MCP. */
export interface SourceRoot {
  readonly id: string;
  readonly nome: string;
  readonly dir: string;
}

interface StoredSource {
  readonly id: string;
  readonly nome: string;
  readonly tipo: ResourceSourceKind;
  readonly url?: string;
  readonly branch?: string;
  /** Só pasta: o caminho absoluto. O clone de um repositório fica em `sources/<id>`. */
  readonly caminho?: string;
  readonly atualizadaEm?: string;
}

interface SourcesFile {
  fontes: StoredSource[];
}

export interface ResourceSourcesOptions {
  /** Pasta do FaKL (`~/.fakl`): `sources.json` e os clones em `sources/<id>`. */
  readonly dir: string;
  /** Credenciais do git por ambiente (o token do GitHub conectado, por exemplo). */
  readonly gitEnv?: () => Readonly<Record<string, string>>;
  /** Executável do git; muda nos testes. */
  readonly git?: string;
  /** Avisado quando o conteúdo das fontes muda (adicionar, remover, atualizar). */
  readonly onChange?: () => void;
  readonly log?: (message: string) => void;
}

const GIT_TIMEOUT_MS = 5 * 60_000;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** `ext::` e afins executam comandos: só transportes de rede, `file://` e o formato `usuario@host:caminho`. */
const URL_SCHEME = /^(?:https?|ssh|git|file):\/\//i;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\\]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** URL de clone aceita; recusa opções disfarçadas (`-u…`) e transportes que rodam comandos. */
export function isGitUrl(url: string): boolean {
  if (url.startsWith('-') || /\s/.test(url)) return false;
  return URL_SCHEME.test(url) || SCP_LIKE.test(url);
}

/** Texto sem espaços nas pontas; vazio vira `undefined`. */
function filled(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === '' ? undefined : text;
}

function isBranch(branch: string): boolean {
  return BRANCH.test(branch) && !branch.includes('..') && !branch.endsWith('.lock');
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** Quantos agentes, skills e modelos de MCP uma pasta de fonte oferece. */
export async function countSource(
  dir: string,
): Promise<{ agents: number; skills: number; mcps: number }> {
  const agents = (
    await readdir(join(dir, 'agents'), { withFileTypes: true }).catch(() => [])
  ).filter(
    (entry) =>
      entry.isFile() && entry.name.endsWith('.md') && isResourceName(entry.name.slice(0, -3)),
  ).length;
  let skills = 0;
  for (const entry of await readdir(join(dir, 'skills'), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !isResourceName(entry.name)) continue;
    if (
      await stat(join(dir, 'skills', entry.name, 'SKILL.md')).then(
        () => true,
        () => false,
      )
    ) {
      skills++;
    }
  }
  let mcps = 0;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'mcps.json'), 'utf8'));
    if (isRecord(parsed) && isRecord(parsed.servers)) mcps = Object.keys(parsed.servers).length;
  } catch {
    // Sem mcps.json, ou ilegível: a fonte não oferece servidores.
  }
  return { agents, skills, mcps };
}

function errorText(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ').trim();
  return text || l10n.t('git exited with code {0}', String(result.code));
}

/**
 * Fontes de recursos de IA: repositórios git, clonados em `~/.fakl/sources/<id>`,
 * ou pastas locais, lidas no lugar. Cada fonte pode ter `agents/<slug>.md`,
 * `skills/<slug>/SKILL.md` e `mcps.json`. Uma fonte só oferece itens: nada é
 * instalado sem o usuário escolher.
 */
export class ResourceSources {
  private fontes: StoredSource[] = [];
  private readonly errors = new Map<string, string>();
  private readonly commits = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ResourceSourcesOptions) {}

  private get file(): string {
    return join(this.options.dir, 'sources.json');
  }

  private get clonesDir(): string {
    return join(this.options.dir, 'sources');
  }

  private dirOf(source: StoredSource): string {
    return source.tipo === 'pasta' && source.caminho
      ? source.caminho
      : join(this.clonesDir, source.id);
  }

  /** Lê `sources.json`; entradas inválidas (editadas à mão) ficam de fora. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.fontes = [];
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.log?.(l10n.t('{0} is corrupted; no source loaded', this.file));
      this.fontes = [];
      return;
    }
    const list = isRecord(parsed) && Array.isArray(parsed.fontes) ? parsed.fontes : [];
    const seen = new Set<string>();
    this.fontes = [];
    for (const item of list) {
      const source = this.parseStored(item);
      if (!source || seen.has(source.id)) {
        this.options.log?.(l10n.t('{0}: source ignored ({1})', this.file, JSON.stringify(item)));
        continue;
      }
      seen.add(source.id);
      this.fontes.push(source);
    }
  }

  private parseStored(item: unknown): StoredSource | undefined {
    if (!isRecord(item) || typeof item.id !== 'string' || !isResourceName(item.id))
      return undefined;
    const nome = typeof item.nome === 'string' && item.nome.trim() ? item.nome.trim() : item.id;
    const atualizadaEm = typeof item.atualizadaEm === 'string' ? item.atualizadaEm : undefined;
    if (item.tipo === 'git') {
      if (typeof item.url !== 'string' || !isGitUrl(item.url)) return undefined;
      const branch =
        typeof item.branch === 'string' && isBranch(item.branch) ? item.branch : undefined;
      return {
        id: item.id,
        nome,
        tipo: 'git',
        url: item.url,
        ...(branch ? { branch } : {}),
        ...(atualizadaEm ? { atualizadaEm } : {}),
      };
    }
    if (item.tipo === 'pasta') {
      if (typeof item.caminho !== 'string' || !isAbsolute(item.caminho)) return undefined;
      return {
        id: item.id,
        nome,
        tipo: 'pasta',
        caminho: item.caminho,
        ...(atualizadaEm ? { atualizadaEm } : {}),
      };
    }
    return undefined;
  }

  private async save(): Promise<void> {
    const file: SourcesFile = { fontes: this.fontes };
    await writeJsonAtomic(this.file, file);
  }

  /** Uma alteração por vez: dois cadastros seguidos não perdem um ao outro. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Fontes na ordem de cadastro; a primeira vence quando dois itens têm o mesmo nome. */
  roots(): SourceRoot[] {
    return this.fontes.map((source) => ({
      id: source.id,
      nome: source.nome,
      dir: this.dirOf(source),
    }));
  }

  get size(): number {
    return this.fontes.length;
  }

  async list(): Promise<ResourceSource[]> {
    return Promise.all(this.fontes.map((source) => this.describe(source)));
  }

  private async describe(source: StoredSource): Promise<ResourceSource> {
    const caminho = this.dirOf(source);
    const present = await isDirectory(caminho);
    const counts = present ? await countSource(caminho) : { agents: 0, skills: 0, mcps: 0 };
    const erro =
      this.errors.get(source.id) ??
      (present
        ? undefined
        : source.tipo === 'pasta'
          ? l10n.t('the folder no longer exists')
          : l10n.t('the repository has not been downloaded yet; use Update'));
    if (source.tipo === 'git' && present && !this.commits.has(source.id)) {
      await this.readCommit(source.id, caminho);
    }
    const commit = this.commits.get(source.id);
    return {
      id: source.id,
      nome: source.nome,
      tipo: source.tipo,
      ...(source.url ? { url: source.url } : {}),
      ...(source.branch ? { branch: source.branch } : {}),
      caminho,
      ...(source.atualizadaEm ? { atualizadaEm: source.atualizadaEm } : {}),
      ...(commit ? { commit } : {}),
      ...(erro ? { erro } : {}),
      ...counts,
    };
  }

  private uniqueId(base: string): string {
    const slug = resourceSlug(base) || 'fonte';
    const taken = new Set(this.fontes.map((source) => source.id));
    if (!taken.has(slug) && isResourceName(slug)) return slug;
    for (let n = 2; ; n++) {
      const candidate = `${slug.slice(0, 60)}-${String(n)}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Cadastra um repositório git (clonado agora) ou uma pasta local. */
  add(params: AddResourceSourceParams): Promise<ResourceSource> {
    return this.serial(async () => {
      const url = filled(params.url);
      const caminho = filled(params.caminho);
      const nome = filled(params.nome);
      if (!!url === !!caminho) {
        throw RpcError.invalidParams(
          l10n.t('provide url (git repository) or caminho (folder), one of the two'),
        );
      }
      const branch = filled(params.branch);
      if (branch && !isBranch(branch)) {
        throw RpcError.invalidParams(l10n.t('invalid branch: {0}', branch));
      }
      let source: StoredSource;
      if (url) {
        if (!isGitUrl(url)) {
          throw RpcError.invalidParams(
            l10n.t(
              'invalid repository URL: use https://, ssh://, git://, file:// or user@host:path',
            ),
          );
        }
        // Sem branch, vale o padrão do remoto, que é o que a fonte já cadastrada acompanha.
        if (this.fontes.some((item) => item.url === url && (!branch || item.branch === branch))) {
          throw RpcError.invalidParams(l10n.t('the source {0} is already registered', url));
        }
        const id = this.uniqueId(nome ?? basename(url).replace(/\.git$/i, ''));
        const cloned = await this.clone(id, url, branch);
        source = {
          id,
          nome: nome ?? id,
          tipo: 'git',
          url,
          ...(cloned.branch ? { branch: cloned.branch } : {}),
          atualizadaEm: new Date().toISOString(),
        };
      } else {
        const dir = resolve(caminho ?? '');
        if (!isAbsolute(caminho ?? '')) {
          throw RpcError.invalidParams(l10n.t('caminho must be absolute'));
        }
        if (!(await isDirectory(dir))) {
          throw RpcError.invalidParams(l10n.t('{0} is not a folder', dir));
        }
        if (this.fontes.some((item) => item.tipo === 'pasta' && item.caminho === dir)) {
          throw RpcError.invalidParams(l10n.t('the folder {0} is already a source', dir));
        }
        const id = this.uniqueId(nome ?? basename(dir));
        source = {
          id,
          nome: nome ?? filled(basename(dir)) ?? id,
          tipo: 'pasta',
          caminho: dir,
          atualizadaEm: new Date().toISOString(),
        };
      }
      this.fontes.push(source);
      await this.save();
      this.options.onChange?.();
      return this.describe(source);
    });
  }

  /** Tira a fonte da lista e apaga o clone; o que já foi instalado continua na biblioteca. */
  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const source = this.fontes.find((item) => item.id === id);
      if (!source) return false;
      this.fontes = this.fontes.filter((item) => item !== source);
      this.errors.delete(id);
      this.commits.delete(id);
      await this.save();
      if (source.tipo === 'git') {
        await rm(join(this.clonesDir, source.id), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        }).catch((error: unknown) => {
          this.options.log?.(
            l10n.t('could not delete the clone of source {0}: {1}', id, String(error)),
          );
        });
      }
      this.options.onChange?.();
      return true;
    });
  }

  /**
   * Baixa a versão nova dos repositórios (um, ou todos sem `id`) e relê as
   * pastas. Uma fonte que falha não impede as outras: o erro fica nela.
   */
  update(id?: string): Promise<ResourceSource[]> {
    return this.serial(async () => {
      const targets = id ? this.fontes.filter((item) => item.id === id) : [...this.fontes];
      if (id && targets.length === 0) {
        throw RpcError.notFound(l10n.t('source {0} does not exist', id));
      }
      let changed = false;
      for (const source of targets) {
        changed = (await this.refreshOne(source)) || changed;
      }
      if (changed) await this.save();
      this.options.onChange?.();
      return Promise.all(targets.map((source) => this.describe(this.current(source.id) ?? source)));
    });
  }

  /** Repositórios cadastrados sem clone (sources.json copiado de outra máquina): baixa agora. */
  ensureClones(): Promise<void> {
    return this.serial(async () => {
      let changed = false;
      for (const source of this.fontes) {
        if (source.tipo !== 'git' || (await isDirectory(this.dirOf(source)))) continue;
        changed = (await this.refreshOne(source)) || changed;
      }
      if (changed) {
        await this.save();
        this.options.onChange?.();
      }
    });
  }

  private current(id: string): StoredSource | undefined {
    return this.fontes.find((item) => item.id === id);
  }

  private async refreshOne(source: StoredSource): Promise<boolean> {
    try {
      if (source.tipo === 'pasta') {
        if (!(await isDirectory(this.dirOf(source)))) {
          throw new Error(l10n.t('the folder no longer exists'));
        }
      } else {
        const dir = this.dirOf(source);
        if (await isDirectory(join(dir, '.git'))) await this.pull(source, dir);
        else await this.clone(source.id, source.url ?? '', source.branch);
      }
      this.errors.delete(source.id);
      this.replace({ ...source, atualizadaEm: new Date().toISOString() });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(source.id, message);
      this.options.log?.(l10n.t('could not update the source {0}: {1}', source.id, message));
      return false;
    }
  }

  private replace(source: StoredSource): void {
    this.fontes = this.fontes.map((item) => (item.id === source.id ? source : item));
  }

  private git(args: readonly string[], cwd: string): Promise<ExecResult> {
    return run(
      this.options.git ?? 'git',
      // Nunca deixa um remoto rodar comandos (ext::); o run() já impede pedir senha no terminal.
      ['-c', 'protocol.ext.allow=never', ...args],
      { cwd, env: { ...this.options.gitEnv?.() }, timeoutMs: GIT_TIMEOUT_MS, tailChars: 4000 },
    );
  }

  /** Clona numa pasta temporária e só então troca: um clone falho não apaga o anterior. */
  private async clone(
    id: string,
    url: string,
    branch: string | undefined,
  ): Promise<{ branch?: string }> {
    await mkdir(this.clonesDir, { recursive: true });
    const staging = await mkdtemp(join(this.clonesDir, `.${id}-`));
    const target = join(staging, 'repo');
    try {
      const result = await this.git(
        [
          'clone',
          '--depth',
          '1',
          '--single-branch',
          ...(branch ? ['--branch', branch] : []),
          '--',
          url,
          target,
        ],
        this.clonesDir,
      );
      if (result.code !== 0) throw new Error(l10n.t('git clone failed: {0}', errorText(result)));
      const head = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], target);
      const current = head.code === 0 ? head.stdout.trim() : '';
      await this.readCommit(id, target);
      const dest = join(this.clonesDir, id);
      await rm(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rename(target, dest);
      return branch ? { branch } : current && current !== 'HEAD' ? { branch: current } : {};
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
        () => undefined,
      );
    }
  }

  /** Busca o branch acompanhado e deixa o clone igual ao remoto (é só leitura). */
  private async pull(source: StoredSource, dir: string): Promise<void> {
    const ref = source.branch ?? 'HEAD';
    const fetched = await this.git(['fetch', '--depth', '1', 'origin', ref], dir);
    if (fetched.code !== 0) throw new Error(l10n.t('git fetch failed: {0}', errorText(fetched)));
    const reset = await this.git(['reset', '--hard', 'FETCH_HEAD'], dir);
    if (reset.code !== 0) throw new Error(l10n.t('git reset failed: {0}', errorText(reset)));
    const cleaned = await this.git(['clean', '-ffdx'], dir);
    if (cleaned.code !== 0) throw new Error(l10n.t('git clean failed: {0}', errorText(cleaned)));
    await this.readCommit(source.id, dir);
  }

  private async readCommit(id: string, dir: string): Promise<void> {
    const result = await this.git(['rev-parse', '--short', 'HEAD'], dir);
    if (result.code === 0 && result.stdout.trim()) this.commits.set(id, result.stdout.trim());
  }

  register(router: Router): void {
    router.register('sources.list', () => this.list());
    router.register('sources.add', (params) => {
      const p = objectParams(params);
      const optional = (key: string): string | undefined => {
        const value = p[key];
        if (value === undefined || value === null) return undefined;
        if (typeof value !== 'string') {
          throw RpcError.invalidParams(l10n.t('{0} must be text', key));
        }
        return value;
      };
      const url = optional('url');
      const branch = optional('branch');
      const caminho = optional('caminho');
      const nome = optional('nome');
      return this.add({
        ...(url ? { url } : {}),
        ...(branch ? { branch } : {}),
        ...(caminho ? { caminho } : {}),
        ...(nome ? { nome } : {}),
      });
    });
    router.register('sources.remove', (params) =>
      this.remove(stringParam(objectParams(params), 'id')),
    );
    router.register('sources.update', (params) => {
      const p = params === undefined || params === null ? {} : objectParams(params);
      return this.update(typeof p.id === 'string' && p.id ? p.id : undefined);
    });
  }
}
