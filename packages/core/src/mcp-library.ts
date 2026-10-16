import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { l10n } from '@fakl/i18n';
import {
  mcpSecretName,
  type InstalledMcpServer,
  type McpCatalog,
  type McpInputSpec,
  type McpLibraryInfo,
  type McpServerEntry,
  type McpServerMeta,
  type McpSessionServer,
} from '@fakl/protocol';

import {
  objectParams,
  RpcError,
  stringArrayParam,
  stringParam,
  type Router,
} from './rpc/router.js';
import type { SecretVault } from './secrets.js';
import type { SourceRoot } from './sources.js';
import { writeJsonAtomic } from './store.js';

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INPUT_REF = /\$\{input:([A-Za-z0-9_-]{1,64})\}/g;

interface McpFile {
  readonly inputs?: unknown;
  readonly servers?: unknown;
  readonly [key: string]: unknown;
}

interface RawServer {
  readonly type?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
  readonly fakl?: unknown;
}

export interface McpLibraryOptions {
  /** `~/.fakl/mcp.json`. */
  readonly file: string;
  /** Fontes de recursos: o `mcps.json` de cada uma oferece modelos de servidor. */
  readonly sources?: () => readonly SourceRoot[];
  readonly vault: SecretVault;
  readonly log?: (message: string) => void;
  readonly onChange?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.values(value).every((v) => typeof v === 'string')) {
    return undefined;
  }
  return value as Record<string, string>;
}

function inputSpecs(value: unknown): Map<string, McpInputSpec> {
  const specs = new Map<string, McpInputSpec>();
  if (!Array.isArray(value)) return specs;
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    specs.set(item.id, {
      id: item.id,
      description: typeof item.description === 'string' ? item.description : item.id,
      ...(item.password === true ? { password: true } : {}),
    });
  }
  return specs;
}

function inputRefs(server: RawServer): string[] {
  const text = JSON.stringify([
    server.command,
    server.args,
    server.env,
    server.url,
    server.headers,
  ]);
  return [...new Set([...text.matchAll(INPUT_REF)].map((match) => match[1] ?? '').filter(Boolean))];
}

/** Valida um servidor do arquivo; `undefined` quando está malformado. */
function parseServer(
  name: string,
  raw: unknown,
  specs: ReadonlyMap<string, McpInputSpec>,
): McpServerEntry | undefined {
  if (!SERVER_NAME.test(name) || !isRecord(raw)) return undefined;
  const server = raw as RawServer;
  const inputs = inputRefs(server).map((id) => specs.get(id) ?? { id, description: id });
  const fakl = isRecord(server.fakl) ? (server.fakl as McpServerMeta) : undefined;
  if (server.type === 'http' || (server.type === undefined && typeof server.url === 'string')) {
    const headers = stringMap(server.headers);
    if (typeof server.url !== 'string' || !headers) return undefined;
    return { name, type: 'http', url: server.url, headers, inputs, ...(fakl ? { fakl } : {}) };
  }
  const env = stringMap(server.env);
  const args = server.args ?? [];
  if (
    typeof server.command !== 'string' ||
    !server.command ||
    !env ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === 'string')
  ) {
    return undefined;
  }
  return {
    name,
    type: 'stdio',
    command: server.command,
    args,
    env,
    inputs,
    ...(fakl ? { fakl } : {}),
  };
}

/**
 * Servidores MCP instalados na IDE e entregues a todos os agentes, além dos do
 * `config.yaml`. O arquivo segue o `mcp.json` do VS Code e pode ser editado à
 * mão; segredos (`${input:id}`) ficam só no cofre, nunca no arquivo.
 */
export class McpLibrary {
  private writing: Promise<unknown> = Promise.resolve();
  private snapshot: McpSessionServer[] = [];
  private readonly reported = new Set<string>();

  constructor(private readonly options: McpLibraryOptions) {}

  private async readFileJson(path: string): Promise<McpFile | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error(l10n.t('{0}: the file must be an object', path));
    return parsed;
  }

  private parse(file: McpFile | undefined, where: string): McpServerEntry[] {
    if (file?.servers === undefined) return [];
    if (!isRecord(file.servers)) throw new Error(l10n.t('{0}: servers must be an object', where));
    const specs = inputSpecs(file.inputs);
    const entries: McpServerEntry[] = [];
    for (const [name, raw] of Object.entries(file.servers)) {
      const entry = parseServer(name, raw, specs);
      if (entry) entries.push(entry);
      else
        this.options.log?.(
          l10n.t('{0}: MCP server {1} ignored (invalid configuration)', where, name),
        );
    }
    return entries;
  }

  private async installed(): Promise<McpServerEntry[]> {
    try {
      return this.parse(await this.readFileJson(this.options.file), this.options.file);
    } catch (error) {
      this.options.log?.(l10n.t('could not read {0}: {1}', this.options.file, String(error)));
      return [];
    }
  }

  /** `mcps.json` de cada fonte, na ordem de prioridade; arquivo ilegível fica de fora. */
  private async catalogEntries(): Promise<
    { root: SourceRoot; file: McpFile; entries: McpServerEntry[] }[]
  > {
    const result: { root: SourceRoot; file: McpFile; entries: McpServerEntry[] }[] = [];
    for (const root of this.options.sources?.() ?? []) {
      const path = join(root.dir, 'mcps.json');
      try {
        const file = await this.readFileJson(path);
        if (file) result.push({ root, file, entries: this.parse(file, path) });
      } catch (error) {
        this.options.log?.(l10n.t('could not read {0}: {1}', path, String(error)));
      }
    }
    return result;
  }

  private missing(entry: McpServerEntry): string[] {
    return entry.inputs
      .map((input) => input.id)
      .filter((id) => !this.options.vault.has(mcpSecretName(id)));
  }

  async list(): Promise<McpLibraryInfo> {
    const servers: InstalledMcpServer[] = (await this.installed()).map((entry) => ({
      ...entry,
      faltando: this.missing(entry),
    }));
    return { servers, arquivo: this.options.file };
  }

  async catalog(): Promise<McpCatalog> {
    const installed = new Set((await this.installed()).map((entry) => entry.name));
    return {
      servers: (await this.catalogEntries()).flatMap(({ root, entries }) =>
        entries.map((entry) => ({
          ...entry,
          fonte: root.id,
          instalado: installed.has(entry.name),
        })),
      ),
    };
  }

  /** Grava em série: duas instalações seguidas não perdem uma à outra. */
  private update(change: (file: Record<string, unknown>) => boolean): Promise<boolean> {
    const run = this.writing.then(async () => {
      // Arquivo ilegível: melhor falhar do que sobrescrever o que o usuário escreveu.
      const current = { ...((await this.readFileJson(this.options.file)) ?? {}) };
      if (current.servers !== undefined && !isRecord(current.servers)) {
        throw RpcError.invalidParams(l10n.t('{0}: servers must be an object', this.options.file));
      }
      const changed = change(current);
      if (changed) {
        await writeJsonAtomic(this.options.file, current);
        await this.refresh();
        this.options.onChange?.();
      }
      return changed;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  /** Copia modelos de uma fonte (a pedida, ou a primeira que tiver cada nome). */
  async install(names: readonly string[], fonte?: string): Promise<McpLibraryInfo> {
    const sources = await this.catalogEntries();
    if (fonte !== undefined && !sources.some(({ root }) => root.id === fonte)) {
      throw RpcError.notFound(l10n.t('source {0} does not exist or has no mcps.json', fonte));
    }
    const chosen = new Map<string, { raw: RawServer; inputs: unknown[] }>();
    for (const name of names) {
      const source = sources.find(
        ({ root, file }) =>
          (fonte === undefined || root.id === fonte) &&
          isRecord(file.servers) &&
          Object.hasOwn(file.servers, name),
      );
      if (!source) {
        throw RpcError.notFound(
          fonte !== undefined
            ? l10n.t('the MCP server {0} is not in source {1}', name, fonte)
            : l10n.t('the MCP server {0} is not in any source', name),
        );
      }
      chosen.set(name, {
        raw: (source.file.servers as Record<string, unknown>)[name] as RawServer,
        inputs: Array.isArray(source.file.inputs) ? source.file.inputs : [],
      });
    }
    await this.update((file) => {
      const servers = { ...((file.servers as Record<string, unknown> | undefined) ?? {}) };
      const inputs = Array.isArray(file.inputs) ? [...(file.inputs as unknown[])] : [];
      const known = new Set(inputSpecs(inputs).keys());
      let changed = false;
      for (const name of names) {
        // Já instalado: mantém a versão do usuário, que pode ter sido editada.
        if (Object.hasOwn(servers, name)) continue;
        const pick = chosen.get(name);
        if (!pick) continue;
        const { raw, inputs: sourceInputs } = pick;
        servers[name] = raw;
        for (const id of inputRefs(raw)) {
          if (known.has(id)) continue;
          const spec = sourceInputs.find((item) => isRecord(item) && item.id === id);
          if (spec) inputs.push(spec);
          known.add(id);
        }
        changed = true;
      }
      if (changed) {
        file.servers = servers;
        file.inputs = inputs;
      }
      return changed;
    });
    return this.list();
  }

  async remove(name: string): Promise<boolean> {
    return this.update((file) => {
      const servers = { ...((file.servers as Record<string, unknown> | undefined) ?? {}) };
      if (!Object.hasOwn(servers, name)) return false;
      const remaining = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== name));
      const used = new Set(Object.values(remaining).flatMap((raw) => inputRefs(raw as RawServer)));
      file.servers = remaining;
      if (Array.isArray(file.inputs)) {
        file.inputs = (file.inputs as unknown[]).filter(
          (item) => !isRecord(item) || typeof item.id !== 'string' || used.has(item.id),
        );
      }
      return true;
    });
  }

  /**
   * Servidores prontos para uma sessão, com os segredos do cofre no lugar dos
   * `${input:id}`. Um servidor com segredo faltando fica de fora.
   */
  async sessionServers(): Promise<McpSessionServer[]> {
    const fill = (text: string): string =>
      text.replace(INPUT_REF, (_, id: string) => this.options.vault.get(mcpSecretName(id)) ?? '');
    const fillMap = (map: Readonly<Record<string, string>> | undefined): Record<string, string> =>
      Object.fromEntries(Object.entries(map ?? {}).map(([key, value]) => [key, fill(value)]));
    const servers: McpSessionServer[] = [];
    for (const entry of await this.installed()) {
      const missing = this.missing(entry);
      if (missing.length > 0) {
        const key = `${entry.name}:${missing.join(',')}`;
        if (!this.reported.has(key)) {
          this.reported.add(key);
          this.options.log?.(
            l10n.t(
              'MCP server {0} outside sessions: missing secret {1}',
              entry.name,
              missing.join(', '),
            ),
          );
        }
        continue;
      }
      if (entry.type === 'http') {
        servers.push({
          nome: entry.name,
          url: fill(entry.url ?? ''),
          headers: fillMap(entry.headers),
        });
      } else {
        servers.push({
          nome: entry.name,
          comando: fill(entry.command ?? ''),
          args: (entry.args ?? []).map(fill),
          env: fillMap(entry.env),
        });
      }
    }
    return servers;
  }

  /** Relê o arquivo e o cofre; chamado ao abrir, ao instalar e quando um segredo muda. */
  async refresh(): Promise<void> {
    this.snapshot = await this.sessionServers();
  }

  /**
   * Retrato para o início de uma sessão, que é síncrono. Cada chamada dispara
   * uma releitura em segundo plano, para a próxima sessão ver edições à mão.
   */
  current(): readonly McpSessionServer[] {
    void this.refresh().catch((error: unknown) => {
      this.options.log?.(l10n.t('could not re-read the MCP servers: {0}', String(error)));
    });
    return this.snapshot;
  }

  register(router: Router): void {
    router.register('mcps.list', () => this.list());
    router.register('mcps.catalog', () => this.catalog());
    router.register('mcps.install', (params) => {
      const p = objectParams(params);
      if (p.fonte !== undefined && typeof p.fonte !== 'string') {
        throw RpcError.invalidParams(l10n.t('fonte must be the id of a source'));
      }
      return this.install(stringArrayParam(p, 'names'), p.fonte);
    });
    router.register('mcps.remove', (params) =>
      this.remove(stringParam(objectParams(params), 'name')),
    );
  }
}
