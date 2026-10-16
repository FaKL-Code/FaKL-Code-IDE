import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { l10n } from '@fakl/i18n';
import {
  isResourceKind,
  type CatalogResourceInfo,
  type ResourceCatalog,
  type ResourceContent,
  type ResourceInfo,
  type ResourceKind,
  type ResourceLevel,
  type ResourceLibrary as ResourceLibraryState,
} from '@fakl/protocol';
import { parse } from 'yaml';

import { objectParams, RpcError, stringParam, type Router } from './rpc/router.js';
import type { SourceRoot } from './sources.js';
import { writeJsonAtomic } from './store.js';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** Slug de agente ou skill: vira nome de arquivo e de pasta. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/;
const LEVELS: readonly ResourceLevel[] = ['leve', 'padrao', 'pesado'];

export interface ResourceLibraryOptions {
  /** Biblioteca do usuário (`~/.fakl/resources`). */
  readonly dir: string;
  /** Fontes cadastradas, na ordem de prioridade; sem fontes, só há o que o usuário criou. */
  readonly sources?: () => readonly SourceRoot[];
  /** Avisado a cada mudança na biblioteca (instalar, criar, remover). */
  readonly onChange?: () => void;
  readonly log?: (message: string) => void;
}

interface State {
  /** Item instalado → id da fonte de onde veio. */
  origens: Record<string, string>;
  /** Formato antigo: itens semeados do catálogo que vinha embutido na IDE. */
  conhecidos?: string[];
}

/** Nome de agente ou skill sem caminho: recusa `..`, barras e afins. */
export function isResourceName(name: string): boolean {
  return (
    SLUG.test(name) && !name.includes('..') && !name.endsWith('.') && !WINDOWS_DEVICE.test(name)
  );
}

/** Slug seguro a partir de um nome livre ("Revisor de PR" → `revisor-de-pr`). */
export function resourceSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** Frontmatter YAML e corpo de um arquivo Markdown. */
export function splitFrontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parse(match[1] ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Frontmatter inválido: vale como se não houvesse.
  }
  return { data, body: text.slice(match[0].length) };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Lê nome, descrição e o bloco `fakl` do frontmatter de um agente ou skill. */
export function resourceInfo(
  kind: ResourceKind,
  name: string,
  content: string,
  path: string,
  origem: ResourceInfo['origem'],
  fonte?: string,
): ResourceInfo {
  const { data } = splitFrontmatter(content);
  const fakl =
    data.fakl && typeof data.fakl === 'object' && !Array.isArray(data.fakl)
      ? (data.fakl as Record<string, unknown>)
      : {};
  const nivel = text(fakl.nivel);
  const fontes = Array.isArray(fakl.fontes)
    ? fakl.fontes.filter((item): item is string => typeof item === 'string')
    : undefined;
  const perfil = text(fakl.perfil);
  const modelo = text(fakl.modelo);
  const alternativa = text(fakl.alternativa);
  const licenca = text(fakl.licenca);
  const padrao = fakl.padrao === false ? false : undefined;
  return {
    kind,
    name,
    description: text(data.description) ?? '',
    ...(nivel && (LEVELS as readonly string[]).includes(nivel)
      ? { nivel: nivel as ResourceLevel }
      : {}),
    ...(perfil ? { perfil } : {}),
    ...(modelo ? { modelo } : {}),
    ...(alternativa ? { alternativa } : {}),
    ...(fontes && fontes.length > 0 ? { fontes } : {}),
    ...(licenca ? { licenca } : {}),
    ...(padrao === false ? { padrao } : {}),
    origem,
    ...(fonte ? { fonte } : {}),
    path,
  };
}

function key(kind: ResourceKind, name: string): string {
  return `${kind}:${name}`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function kindParam(p: Record<string, unknown>): ResourceKind {
  if (!isResourceKind(p.kind)) throw RpcError.invalidParams(l10n.t('kind must be agent or skill'));
  return p.kind;
}

function nameParam(p: Record<string, unknown>): string {
  const name = stringParam(p, 'name');
  if (!isResourceName(name)) throw RpcError.invalidParams(l10n.t('invalid name: {0}', name));
  return name;
}

/**
 * Agentes e skills instalados na IDE (`~/.fakl/resources`). Os itens vêm das
 * fontes de recursos cadastradas pelo usuário (repositórios git ou pastas) ou
 * são criados aqui. Nada é instalado sozinho: a biblioteca começa vazia e só
 * recebe o que o usuário escolhe. Itens instalados nunca são sobrescritos.
 */
export class ResourceLibrary {
  /** Item instalado → fonte de onde veio. */
  private origins = new Map<string, string>();
  /** Itens semeados pelo catálogo embutido de versões antigas: vieram de uma fonte sem id. */
  private legacy = new Set<string>();

  constructor(private readonly options: ResourceLibraryOptions) {}

  get dir(): string {
    return this.options.dir;
  }

  private get statePath(): string {
    return join(this.dir, 'state.json');
  }

  private sourceRoots(): readonly SourceRoot[] {
    return this.options.sources?.() ?? [];
  }

  /** Arquivo principal (`agents/<slug>.md` ou `skills/<slug>/SKILL.md`) numa raiz. */
  static fileOf(root: string, kind: ResourceKind, name: string): string {
    return kind === 'agent'
      ? join(root, 'agents', `${name}.md`)
      : join(root, 'skills', name, 'SKILL.md');
  }

  /** O que é copiado: o arquivo do agente ou a pasta inteira da skill. */
  private static entryOf(root: string, kind: ResourceKind, name: string): string {
    return kind === 'agent' ? join(root, 'agents', `${name}.md`) : join(root, 'skills', name);
  }

  /** Prepara as pastas e lê de onde veio cada item instalado. Não instala nada. */
  async init(): Promise<void> {
    await mkdir(join(this.dir, 'agents'), { recursive: true });
    await mkdir(join(this.dir, 'skills'), { recursive: true });
    await this.loadState();
  }

  private async loadState(): Promise<void> {
    this.origins = new Map();
    this.legacy = new Set();
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const valid = (item: string): boolean =>
      (item.startsWith('agent:') || item.startsWith('skill:')) &&
      isResourceName(item.slice(item.indexOf(':') + 1));
    try {
      const state = JSON.parse(raw) as Partial<State>;
      if (state.origens && typeof state.origens === 'object' && !Array.isArray(state.origens)) {
        for (const [item, source] of Object.entries(state.origens)) {
          if (valid(item) && typeof source === 'string' && isResourceName(source)) {
            this.origins.set(item, source);
          }
        }
      }
      if (Array.isArray(state.conhecidos)) {
        for (const item of state.conhecidos) {
          if (typeof item === 'string' && valid(item)) this.legacy.add(item);
        }
      }
    } catch {
      // Estado ilegível só perde a origem dos itens; os arquivos instalados ficam.
      this.options.log?.(l10n.t('resources state.json is corrupted; item origins discarded'));
    }
  }

  private async saveState(): Promise<void> {
    const state: State = {
      origens: Object.fromEntries([...this.origins].sort(([a], [b]) => a.localeCompare(b))),
      ...(this.legacy.size > 0 ? { conhecidos: [...this.legacy].sort() } : {}),
    };
    await writeJsonAtomic(this.statePath, state);
  }

  /** Slugs de um tipo numa raiz (biblioteca ou fonte). */
  private async namesIn(root: string, kind: ResourceKind): Promise<string[]> {
    const dir = join(root, kind === 'agent' ? 'agents' : 'skills');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const names: string[] = [];
    for (const entry of entries) {
      if (kind === 'agent') {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const name = entry.name.slice(0, -3);
        if (isResourceName(name)) names.push(name);
      } else if (
        entry.isDirectory() &&
        isResourceName(entry.name) &&
        (await exists(join(dir, entry.name, 'SKILL.md')))
      ) {
        names.push(entry.name);
      }
    }
    return names.sort();
  }

  /** Origem de um item instalado: a fonte de onde veio, ou o próprio usuário. */
  private originOf(
    kind: ResourceKind,
    name: string,
  ): { origem: ResourceInfo['origem']; fonte?: string } {
    const source = this.origins.get(key(kind, name));
    if (source) return { origem: 'fonte', fonte: source };
    return this.legacy.has(key(kind, name)) ? { origem: 'fonte' } : { origem: 'usuario' };
  }

  private async readInstalled(kind: ResourceKind, name: string): Promise<ResourceInfo> {
    const path = ResourceLibrary.fileOf(this.dir, kind, name);
    const content = await readFile(path, 'utf8');
    const { origem, fonte } = this.originOf(kind, name);
    return resourceInfo(kind, name, content, path, origem, fonte);
  }

  private async readFromSource(
    root: SourceRoot,
    kind: ResourceKind,
    name: string,
  ): Promise<{ info: ResourceInfo; content: string }> {
    const path = ResourceLibrary.fileOf(root.dir, kind, name);
    const content = await readFile(path, 'utf8');
    return { info: resourceInfo(kind, name, content, path, 'fonte', root.id), content };
  }

  /** Agentes e skills instalados. */
  async list(): Promise<ResourceLibraryState> {
    const listKind = async (kind: ResourceKind): Promise<ResourceInfo[]> => {
      const infos: ResourceInfo[] = [];
      for (const name of await this.namesIn(this.dir, kind)) {
        try {
          infos.push(await this.readInstalled(kind, name));
        } catch (error) {
          this.options.log?.(l10n.t('could not read {0} {1}: {2}', kind, name, String(error)));
        }
      }
      return infos;
    };
    return { agents: await listKind('agent'), skills: await listKind('skill'), dir: this.dir };
  }

  /** O que as fontes oferecem, marcando o que já está instalado. */
  async catalog(): Promise<ResourceCatalog> {
    const roots = this.sourceRoots();
    const mark = async (kind: ResourceKind): Promise<CatalogResourceInfo[]> => {
      const installed = new Set(await this.namesIn(this.dir, kind));
      const entries: CatalogResourceInfo[] = [];
      for (const root of roots) {
        for (const name of await this.namesIn(root.dir, kind)) {
          try {
            const { info } = await this.readFromSource(root, kind, name);
            entries.push({ ...info, fonte: root.id, instalado: installed.has(name) });
          } catch (error) {
            this.options.log?.(
              l10n.t(
                'could not read {0} {1} from source {2}: {3}',
                kind,
                name,
                root.id,
                String(error),
              ),
            );
          }
        }
      }
      return entries;
    };
    return { agents: await mark('agent'), skills: await mark('skill') };
  }

  /** A fonte que oferece o item: a pedida, ou a primeira que o tiver. */
  private async sourceFor(kind: ResourceKind, name: string, fonte?: string): Promise<SourceRoot> {
    const roots = this.sourceRoots();
    if (fonte !== undefined) {
      const root = roots.find((candidate) => candidate.id === fonte);
      if (!root) throw RpcError.notFound(l10n.t('source {0} does not exist', fonte));
      if (!(await exists(ResourceLibrary.fileOf(root.dir, kind, name)))) {
        throw RpcError.notFound(l10n.t('{0} {1} is not in source {2}', kind, name, fonte));
      }
      return root;
    }
    for (const root of roots) {
      if (await exists(ResourceLibrary.fileOf(root.dir, kind, name))) return root;
    }
    throw RpcError.notFound(
      roots.length === 0
        ? l10n.t('no resource source registered')
        : l10n.t('{0} {1} is not in any source', kind, name),
    );
  }

  /** Copia de uma fonte; o que já está instalado (talvez editado) fica como está. */
  async install(
    kind: ResourceKind,
    names: readonly string[],
    fonte?: string,
  ): Promise<ResourceInfo[]> {
    const plan: { name: string; root: SourceRoot }[] = [];
    for (const name of names) {
      if (!isResourceName(name)) throw RpcError.invalidParams(l10n.t('invalid name: {0}', name));
      plan.push({ name, root: await this.sourceFor(kind, name, fonte) });
    }
    const installed: ResourceInfo[] = [];
    for (const { name, root } of plan) {
      const target = ResourceLibrary.entryOf(this.dir, kind, name);
      if (!(await exists(target))) {
        await cp(ResourceLibrary.entryOf(root.dir, kind, name), target, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        this.origins.set(key(kind, name), root.id);
        this.legacy.delete(key(kind, name));
      }
      installed.push(await this.readInstalled(kind, name));
    }
    await this.saveState();
    if (installed.length > 0) this.options.onChange?.();
    return installed;
  }

  /** Modelo em branco, com frontmatter; erro se o slug já existir. */
  async create(kind: ResourceKind, rawName: string, description?: string): Promise<ResourceInfo> {
    const name = resourceSlug(rawName);
    if (!isResourceName(name)) throw RpcError.invalidParams(l10n.t('invalid name: {0}', rawName));
    const entry = ResourceLibrary.entryOf(this.dir, kind, name);
    if (await exists(entry)) {
      throw RpcError.invalidParams(l10n.t('{0} {1} already exists', kind, name));
    }
    const desc =
      text(description) ??
      (kind === 'agent'
        ? l10n.t('Describe when to use this agent.')
        : l10n.t('Describe when to use this skill.'));
    const content = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(desc)}`,
      'fakl:',
      '  nivel: padrao',
      '  perfil: claude-sonnet',
      '---',
      '',
      `# ${rawName.trim() || name}`,
      '',
      kind === 'agent'
        ? l10n.t('Agent instructions: role, how to work and what to deliver.')
        : l10n.t('Skill instructions: when to use, steps and examples.'),
      '',
    ].join('\n');
    const file = ResourceLibrary.fileOf(this.dir, kind, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content, { flag: 'wx' });
    // Um slug que já veio de uma fonte e foi removido volta a ser do usuário.
    if (this.origins.delete(key(kind, name)) || this.legacy.delete(key(kind, name))) {
      await this.saveState();
    }
    this.options.onChange?.();
    return this.readInstalled(kind, name);
  }

  /** Apaga da biblioteca; continua disponível na fonte para instalar de novo. */
  async remove(kind: ResourceKind, name: string): Promise<boolean> {
    if (!isResourceName(name)) throw RpcError.invalidParams(l10n.t('invalid name: {0}', name));
    const entry = ResourceLibrary.entryOf(this.dir, kind, name);
    if (!(await exists(entry))) return false;
    await rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (this.origins.delete(key(kind, name)) || this.legacy.delete(key(kind, name))) {
      await this.saveState();
    }
    this.options.onChange?.();
    return true;
  }

  /**
   * Conteúdo de um agente ou skill. Sem estar instalado, vale o da primeira
   * fonte que o tiver (só leitura): o maestro usa qualquer item sem instalar.
   */
  async get(kind: ResourceKind, name: string): Promise<ResourceContent> {
    if (!isResourceName(name)) throw RpcError.invalidParams(l10n.t('invalid name: {0}', name));
    const path = ResourceLibrary.fileOf(this.dir, kind, name);
    try {
      const content = await readFile(path, 'utf8');
      const { origem, fonte } = this.originOf(kind, name);
      return {
        info: resourceInfo(kind, name, content, path, origem, fonte),
        content,
        instalado: true,
      };
    } catch (error) {
      // Só "não instalado" cai nas fontes; outro erro não troca a versão do usuário pela da fonte.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const root of this.sourceRoots()) {
      try {
        return { ...(await this.readFromSource(root, kind, name)), instalado: false };
      } catch {
        // Não está nesta fonte.
      }
    }
    throw RpcError.notFound(
      l10n.t(
        '{0} {1} is not installed nor in the resource sources; search with find_resources',
        kind,
        name,
      ),
    );
  }

  register(router: Router): void {
    router.register('resources.list', () => this.list());
    router.register('resources.catalog', () => this.catalog());
    router.register('resources.install', (params) => {
      const p = objectParams(params);
      if (!Array.isArray(p.names) || p.names.some((name) => typeof name !== 'string')) {
        throw RpcError.invalidParams(l10n.t('names must be a list of names'));
      }
      if (p.fonte !== undefined && typeof p.fonte !== 'string') {
        throw RpcError.invalidParams(l10n.t('fonte must be the id of a source'));
      }
      return this.install(kindParam(p), p.names as string[], p.fonte);
    });
    router.register('resources.create', (params) => {
      const p = objectParams(params);
      return this.create(
        kindParam(p),
        stringParam(p, 'name'),
        typeof p.description === 'string' ? p.description : undefined,
      );
    });
    router.register('resources.remove', (params) => {
      const p = objectParams(params);
      return this.remove(kindParam(p), nameParam(p));
    });
    router.register('resources.get', (params) => {
      const p = objectParams(params);
      return this.get(kindParam(p), nameParam(p));
    });
  }
}

const SUMMARY_MAX = 140;
const META_MAX = 48;
const RESOURCE_LINE_MAX = 220;

function shortText(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Uma linha por recurso: `nome — nível/perfil — descrição curta`. */
export function resourceLine(info: ResourceInfo): string {
  const meta = shortText([info.nivel, info.perfil].filter(Boolean).join('/'), META_MAX);
  return shortText(
    [info.name, meta, shortText(info.description, SUMMARY_MAX)].filter(Boolean).join(' — '),
    RESOURCE_LINE_MAX,
  );
}
