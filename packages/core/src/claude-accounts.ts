import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

import { findExecutable } from '@fakl/agents';
import { l10n } from '@fakl/i18n';
import {
  CLAUDE_ACCOUNT_SLOTS,
  isClaudeAccountSlot,
  type ClaudeAccountAttribution,
  type ClaudeAccountEventData,
  type ClaudeAccountInfo,
  type ClaudeAccountLogin,
  type ClaudeAccountRef,
  type ClaudeAccountSetActiveParams,
  type ClaudeAccountSlot,
  type ClaudeAccountsState,
  type ClaudeAccountUsage,
  type ClaudeAttributionEntry,
} from '@fakl/protocol';

import { run } from './exec.js';
import { objectParams, RpcError, type Router } from './rpc/router.js';
import { readJson, writeJsonAtomic } from './store.js';

const NO_USAGE: ClaudeAccountUsage = { tokensEntrada: 0, tokensSaida: 0, custoUsd: 0 };
/** Atribuições mais velhas que isso saem: a barra de uso só olha 7 dias. */
const ATTRIBUTION_KEEP_MS = 8 * 86_400_000;
const EMPTY_ATTRIBUTION: ClaudeAccountAttribution = { ativas: [], sessoes: {} };
/** Atividade de uma sessão vai para o arquivo no máximo uma vez por este intervalo. */
const TOUCH_MS = 60_000;
/** Pasta para onde o `projects/` real de um slot vai antes de ir para a pasta comum. */
const STAGING_PREFIX = 'projects.migrando-';

function entryList(value: unknown): ClaudeAttributionEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): ClaudeAttributionEntry[] => {
    const entry = item as { slot?: unknown; desde?: unknown } | null;
    if (typeof entry?.desde !== 'number' || !Number.isFinite(entry.desde)) return [];
    if (entry.slot !== null && !isClaudeAccountSlot(entry.slot)) return [];
    return [{ slot: entry.slot, desde: entry.desde }];
  });
}

/** Lê o arquivo de atribuição descartando o que não tem o formato esperado. */
export function parseAttribution(raw: unknown): ClaudeAccountAttribution {
  if (!raw || typeof raw !== 'object') return EMPTY_ATTRIBUTION;
  const o = raw as Record<string, unknown>;
  const sessoes =
    o.sessoes && typeof o.sessoes === 'object'
      ? Object.fromEntries(
          Object.entries(o.sessoes as Record<string, unknown>)
            .map(([id, list]) => [id, entryList(list)] as const)
            .filter(([, list]) => list.length > 0),
        )
      : {};
  const vistas =
    o.vistas && typeof o.vistas === 'object'
      ? Object.fromEntries(
          Object.entries(o.vistas as Record<string, unknown>).filter(
            (pair): pair is [string, number] => typeof pair[1] === 'number',
          ),
        )
      : {};
  return {
    ativas: entryList(o.ativas),
    sessoes,
    ...(Object.keys(vistas).length > 0 ? { vistas } : {}),
    ...(typeof o.migradoEm === 'number' ? { migradoEm: o.migradoEm } : {}),
  };
}

/**
 * Tira o que não serve mais. Em cada linha do tempo (ativas e a de cada sessão)
 * ficam a última entrada antes do corte, que ainda vale no começo da janela, e
 * as posteriores. Uma sessão sai inteira só sem atividade há 8 dias (`vistas`,
 * a última entrada ou, nas migradas, a data da migração).
 */
export function pruneAttribution(
  attribution: ClaudeAccountAttribution,
  now: number,
): ClaudeAccountAttribution {
  const cutoff = now - ATTRIBUTION_KEEP_MS;
  const migrated = attribution.migradoEm ?? 0;
  const seen = attribution.vistas ?? {};
  const timeline = (list: readonly ClaudeAttributionEntry[]): readonly ClaudeAttributionEntry[] => {
    const last = list.findLastIndex((entry) => entry.desde < cutoff);
    return last > 0 ? list.slice(last) : list;
  };
  const sessoes = Object.fromEntries(
    Object.entries(attribution.sessoes).flatMap(([id, list]) => {
      const active = Math.max(
        seen[id] ?? 0,
        ...list.map((entry) => (entry.desde === 0 ? migrated : entry.desde)),
      );
      return active >= cutoff ? [[id, timeline(list)] as const] : [];
    }),
  );
  const vistas = Object.fromEntries(Object.entries(seen).filter(([id]) => id in sessoes));
  return {
    ativas: timeline(attribution.ativas),
    sessoes,
    ...(Object.keys(vistas).length > 0 ? { vistas } : {}),
    ...(migrated >= cutoff ? { migradoEm: migrated } : {}),
  };
}

/** Arquivos `.jsonl` (sessões do Claude Code) de uma pasta, com a data de mudança. */
async function sessionFiles(dir: string): Promise<{ id: string; mtime: number }[]> {
  const found: { id: string; mtime: number }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sessionFiles(path)));
    else if (entry.name.endsWith('.jsonl')) {
      const info = await stat(path).catch(() => undefined);
      if (info) found.push({ id: entry.name.slice(0, -'.jsonl'.length), mtime: info.mtimeMs });
    }
  }
  return found;
}

/** O que o status do CLI diz de uma conta: nunca o token, só estes campos. */
export interface ClaudeAuthStatus {
  readonly logada?: boolean;
  readonly email?: string;
  readonly plano?: string;
}

/** Roda `claude <args>` com o ambiente dado e devolve a saída; nos testes, um falso. */
export type ClaudeRunner = (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<{ code: number; stdout: string }>;

export interface ClaudeAccountsOptions {
  /** `~/.fakl`; as contas ficam em `accounts/claude/<slot>`. */
  readonly home: string;
  /** Onde guardar apelidos e a conta ativa (sem segredos); sem ele, só na memória. */
  readonly file?: string;
  readonly runClaude?: ClaudeRunner;
  /** Uso de hoje por slot, vindo da contabilidade de custos. */
  readonly usage?: () => Readonly<Partial<Record<ClaudeAccountSlot, ClaudeAccountUsage>>>;
  readonly log?: (message: string) => void;
  /** Troca a conta dos agentes Claude abertos; devolve as sessões afetadas (ADR 0027). */
  readonly onSwitch?: (slot: ClaudeAccountSlot | undefined) => Promise<string[]>;
  /** Publica o evento `claude.account` no barramento. */
  readonly publish?: (data: ClaudeAccountEventData) => void;
  /** Renomeia o `projects/` real de um slot para a migração; nos testes, simula arquivo aberto. */
  readonly moveDir?: (from: string, to: string) => Promise<void>;
}

interface Persisted {
  ativa?: ClaudeAccountSlot;
  apelidos?: Partial<Record<string, string>>;
}

/** Comando que faz o login de uma conta, rodado num terminal da IDE. */
export const CLAUDE_LOGIN_COMMAND = 'claude auth login';

const defaultRunner: ClaudeRunner = async (args, env) => {
  const found = await findExecutable('claude', process.env);
  if (!found) return { code: -1, stdout: '' };
  const result = await run(found, args, {
    cwd: process.cwd(),
    env,
    timeoutMs: 15_000,
    tailChars: 20_000,
  });
  return { code: result.code, stdout: result.stdout };
};

/** Lê só `loggedIn`, `email` e `subscriptionType` da saída de `claude auth status`. */
export function parseAuthStatus(stdout: string): ClaudeAuthStatus {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (typeof raw !== 'object' || raw === null) return {};
    const o = raw as Record<string, unknown>;
    return {
      ...(typeof o.loggedIn === 'boolean' ? { logada: o.loggedIn } : {}),
      ...(typeof o.email === 'string' && o.email ? { email: o.email } : {}),
      ...(typeof o.subscriptionType === 'string' && o.subscriptionType
        ? { plano: o.subscriptionType }
        : {}),
    };
  } catch {
    return {};
  }
}

/** Nome livre na pasta para quem perdeu uma colisão: `<nome>.<marca>.jsonl.bak`. */
async function backupName(dir: string, name: string, tag: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 0; ; n++) {
    const candidate = join(dir, `${stem}.${tag}${n > 0 ? `-${String(n)}` : ''}${ext}.bak`);
    if (!(await lstat(candidate).catch(() => undefined))) return candidate;
  }
}

/**
 * Move o conteúdo de `from` para `to` só com `rename`: nada é copiado nem
 * apagado. Num arquivo que existe nos dois lados, fica com o nome original o
 * maior (as conversas só crescem) e, no empate, o mais novo; o outro fica ao
 * lado com `.bak`. O que não dá para mover (arquivo aberto) fica onde está, e
 * só pastas vazias saem. Devolve quantos arquivos ficaram para trás.
 */
export async function moveInto(
  from: string,
  to: string,
  tag: string,
  log?: (message: string) => void,
): Promise<number> {
  await mkdir(to, { recursive: true, mode: 0o700 });
  let left = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      left += await moveInto(source, target, tag, log);
      await rmdir(source).catch(() => undefined);
      continue;
    }
    try {
      const existing = await lstat(target).catch(() => undefined);
      if (!existing) {
        await rename(source, target);
        continue;
      }
      const mine = await stat(source);
      const keepMine =
        mine.size > existing.size ||
        (mine.size === existing.size && mine.mtimeMs > existing.mtimeMs);
      if (keepMine) {
        await rename(target, await backupName(to, entry.name, 'anterior'));
        await rename(source, target);
      } else {
        await rename(source, await backupName(to, entry.name, tag));
      }
    } catch (error) {
      left++;
      log?.(l10n.t('{0} stays for the next migration: {1}', source, String(error)));
    }
  }
  return left;
}

/**
 * Até três contas do Claude logadas ao mesmo tempo (ADR 0021). Cada slot tem
 * uma pasta de configuração própria (`CLAUDE_CONFIG_DIR`), então os logins não
 * se misturam. O Core nunca lê as credenciais que o CLI grava ali: só pergunta
 * o status ao próprio CLI e guarda apelidos e a conta ativa.
 */
export class ClaudeAccounts {
  private state: Persisted = {};
  private loaded = false;
  private attribution: ClaudeAccountAttribution = EMPTY_ATTRIBUTION;
  private attributionLoaded = false;
  /** Gravações do arquivo de atribuição, uma de cada vez. */
  private attributionWrite: Promise<void> = Promise.resolve();
  /** Última atividade gravada de cada sessão, para não gravar a cada evento. */
  private readonly touched = new Map<string, number>();
  /** Ativações em fila, uma de cada vez, e quantas já foram pedidas. */
  private activation: Promise<unknown> = Promise.resolve();
  private activations = 0;

  constructor(private readonly options: ClaudeAccountsOptions) {}

  /** Pasta de configuração do slot. */
  dir(slot: ClaudeAccountSlot): string {
    return join(this.options.home, 'accounts', 'claude', String(slot));
  }

  /** Variáveis que isolam o CLI no slot; só o caminho da pasta, nada de segredo. */
  env(slot: ClaudeAccountSlot): Record<string, string> {
    return { CLAUDE_CONFIG_DIR: this.dir(slot) };
  }

  /** Pasta comum das conversas do Claude Code, vista como `projects/` em todo slot. */
  sharedProjects(): string {
    return join(this.options.home, 'accounts', 'claude', 'shared', 'projects');
  }

  /** Arquivo que diz de que conta é cada conversa do histórico comum. */
  attributionFile(): string {
    return join(this.options.home, 'accounts', 'claude', 'shared', 'contas.json');
  }

  /** Cria as pastas dos três slots, liga o histórico comum e carrega o que foi guardado. */
  async init(): Promise<void> {
    await this.load();
    for (const slot of CLAUDE_ACCOUNT_SLOTS) {
      await mkdir(this.dir(slot), { recursive: true, mode: 0o700 });
      await this.linkProjects(slot);
    }
    // Primeira vez: a conta ativa de agora vale daqui em diante. Nas outras, só poda.
    await this.updateAttribution((current) =>
      current.ativas.length > 0
        ? current
        : { ...current, ativas: [{ slot: this.state.ativa ?? null, desde: Date.now() }] },
    );
  }

  private async loadAttribution(): Promise<void> {
    if (this.attributionLoaded) return;
    this.attributionLoaded = true;
    this.attribution = parseAttribution(await readJson<unknown>(this.attributionFile()));
  }

  /** Aplica uma mudança na atribuição, poda o que venceu e grava (atômico), uma de cada vez. */
  private updateAttribution(
    change: (current: ClaudeAccountAttribution) => ClaudeAccountAttribution,
  ): Promise<void> {
    const run = this.attributionWrite.then(async () => {
      await this.loadAttribution();
      this.attribution = pruneAttribution(change(this.attribution), Date.now());
      try {
        await writeJsonAtomic(this.attributionFile(), this.attribution);
      } catch (error) {
        this.options.log?.(l10n.t('could not save the account assignment: {0}', String(error)));
      }
    });
    this.attributionWrite = run.catch(() => undefined);
    return run;
  }

  /**
   * Registra a conta com que o Core roda uma sessão do Claude Code (o id ACP é
   * o nome do `.jsonl`), para o uso dela contar nessa conta a partir de agora.
   */
  async recordSession(sessionId: string, slot: ClaudeAccountSlot | undefined): Promise<void> {
    await this.updateAttribution((current) => {
      const list = current.sessoes[sessionId] ?? [];
      const now = Date.now();
      this.touched.set(sessionId, now);
      const vistas = { ...current.vistas, [sessionId]: now };
      if (list.at(-1)?.slot === (slot ?? null)) return { ...current, vistas };
      const entry: ClaudeAttributionEntry = { slot: slot ?? null, desde: now };
      return {
        ...current,
        vistas,
        sessoes: { ...current.sessoes, [sessionId]: [...list, entry] },
      };
    });
  }

  /** A sessão teve atividade: a atribuição dela fica mais 8 dias (grava no máximo 1 vez por minuto). */
  touchSession(sessionId: string): void {
    const now = Date.now();
    if (now - (this.touched.get(sessionId) ?? 0) < TOUCH_MS) return;
    this.touched.set(sessionId, now);
    if (!this.attribution.sessoes[sessionId] && this.attributionLoaded) return;
    void this.updateAttribution((current) =>
      current.sessoes[sessionId]
        ? { ...current, vistas: { ...current.vistas, [sessionId]: now } }
        : current,
    );
  }

  /**
   * Faz `<slot>/projects` apontar para a pasta comum (ADR 0027), para a sessão
   * de um agente ser achada (`session/load`) em qualquer conta. No Windows é
   * junção, que não pede administrador. Um `projects/` real (com um Claude
   * talvez rodando nele) é renomeado de uma vez para uma pasta de migração do
   * slot e o link nasce logo em seguida; se o rename falha (arquivo aberto),
   * nada muda e a migração fica para o próximo início. Depois, o que está na
   * pasta de migração vai para a comum só com rename. Falhas só vão para o log.
   */
  private async linkProjects(slot: ClaudeAccountSlot): Promise<void> {
    const shared = this.sharedProjects();
    const slotDir = this.dir(slot);
    const link = join(slotDir, 'projects');
    try {
      await mkdir(shared, { recursive: true, mode: 0o700 });
      const info = await lstat(link).catch(() => undefined);
      if (info?.isSymbolicLink()) {
        const [current, wanted] = await Promise.all([
          realpath(link).catch(() => ''),
          realpath(shared),
        ]);
        if (current !== wanted) {
          await unlink(link);
          await this.createLink(link);
        }
      } else if (info?.isDirectory()) {
        const staging = join(slotDir, `${STAGING_PREFIX}${String(Date.now())}`);
        try {
          await (this.options.moveDir ?? rename)(link, staging);
        } catch (error) {
          this.options.log?.(
            l10n.t(
              'conversations of account {0} in use; the migration stays for the next startup: {1}',
              String(slot),
              String(error),
            ),
          );
          return;
        }
        await this.createLink(link);
      } else if (info) {
        this.options.log?.(
          l10n.t(
            '{0} is not a folder; the history of account {1} stays separate',
            link,
            String(slot),
          ),
        );
        return;
      } else {
        await this.createLink(link);
      }
      // A migração de agora e a que sobrou de inícios anteriores.
      const leftovers = (await readdir(slotDir)).filter((name) => name.startsWith(STAGING_PREFIX));
      for (const name of leftovers) await this.drainStaging(slot, join(slotDir, name));
    } catch (error) {
      this.options.log?.(
        l10n.t('could not link the history of account {0}: {1}', String(slot), String(error)),
      );
    }
  }

  private async createLink(link: string): Promise<void> {
    await symlink(this.sharedProjects(), link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  /** Leva uma pasta de migração do slot para a pasta comum; o uso antigo fica na conta de origem. */
  private async drainStaging(slot: ClaudeAccountSlot, staging: string): Promise<void> {
    const since = Date.now() - ATTRIBUTION_KEEP_MS;
    const moved = (await sessionFiles(staging)).filter((file) => file.mtime >= since);
    if (moved.length > 0) {
      await this.updateAttribution((current) => ({
        ...current,
        migradoEm: Date.now(),
        sessoes: {
          ...current.sessoes,
          ...Object.fromEntries(
            moved
              .filter((file) => !current.sessoes[file.id])
              .map((file) => [file.id, [{ slot, desde: 0 }]]),
          ),
        },
      }));
    }
    const left = await moveInto(
      staging,
      this.sharedProjects(),
      `slot${String(slot)}`,
      this.options.log,
    );
    if (left === 0) await rmdir(staging).catch(() => undefined);
    else
      this.options.log?.(
        l10n.t('{0} file(s) were left in {1} for the next startup', String(left), staging),
      );
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.options.file) return;
    const saved = await readJson<Persisted>(this.options.file);
    if (saved) {
      this.state = {
        ...(isClaudeAccountSlot(saved.ativa) ? { ativa: saved.ativa } : {}),
        ...(saved.apelidos && typeof saved.apelidos === 'object'
          ? { apelidos: saved.apelidos }
          : {}),
      };
    }
  }

  private async save(): Promise<void> {
    if (this.options.file) await writeJsonAtomic(this.options.file, this.state);
  }

  get active(): ClaudeAccountSlot | undefined {
    return this.state.ativa;
  }

  nickname(slot: ClaudeAccountSlot): string {
    const custom = this.state.apelidos?.[String(slot)]?.trim();
    return custom === undefined || custom === '' ? l10n.t('Account {0}', String(slot)) : custom;
  }

  ref(slot: ClaudeAccountSlot): ClaudeAccountRef {
    return { slot, apelido: this.nickname(slot) };
  }

  /** Slot a usar num agente novo: o pedido, senão a conta ativa; sem nenhum, a padrão do CLI. */
  async resolve(requested?: ClaudeAccountSlot): Promise<ClaudeAccountSlot | undefined> {
    await this.load();
    return requested ?? this.state.ativa;
  }

  /** Cria a pasta do slot e diz como fazer o login nela. */
  async prepare(slot: ClaudeAccountSlot): Promise<ClaudeAccountLogin> {
    await mkdir(this.dir(slot), { recursive: true, mode: 0o700 });
    await this.linkProjects(slot);
    return { slot, dir: this.dir(slot), env: this.env(slot), comando: CLAUDE_LOGIN_COMMAND };
  }

  async rename(slot: ClaudeAccountSlot, apelido: string): Promise<void> {
    await this.load();
    const name = apelido.trim().slice(0, 40);
    const apelidos = {
      ...Object.fromEntries(
        Object.entries(this.state.apelidos ?? {}).filter(([key]) => key !== String(slot)),
      ),
      ...(name ? { [String(slot)]: name } : {}),
    };
    this.state = { ...this.state, apelidos };
    await this.save();
  }

  /** `undefined` tira a conta ativa e volta à conta padrão do CLI. */
  async setActive(slot: ClaudeAccountSlot | undefined): Promise<void> {
    await this.load();
    const rest: Persisted = this.state.apelidos ? { apelidos: this.state.apelidos } : {};
    this.state = slot ? { ...rest, ativa: slot } : rest;
    await this.save();
    await this.updateAttribution((current) => ({
      ...current,
      ativas: [...current.ativas, { slot: slot ?? null, desde: Date.now() }],
    }));
  }

  /**
   * Troca a conta ativa com um clique: grava, troca os agentes Claude abertos
   * (salvo `aplicarEmAbertos: false`) e avisa a IDE pelo evento `claude.account`.
   * Uma ativação de cada vez, na ordem pedida; a que foi superada por outra
   * antes de começar não faz nada e não publica (devolve `undefined`).
   */
  activate(
    slot: ClaudeAccountSlot | undefined,
    aplicarEmAbertos = true,
  ): Promise<ClaudeAccountEventData | undefined> {
    const generation = ++this.activations;
    const run = this.activation.then(() =>
      generation === this.activations ? this.runActivation(slot, aplicarEmAbertos) : undefined,
    );
    this.activation = run.catch(() => undefined);
    return run;
  }

  /** Espera as ativações em fila terminarem. */
  async activated(): Promise<void> {
    await this.activation;
  }

  private async runActivation(
    slot: ClaudeAccountSlot | undefined,
    aplicarEmAbertos: boolean,
  ): Promise<ClaudeAccountEventData> {
    // Sem login, os agentes reabertos falhariam e ficariam parados: a conta vira a
    // ativa para os próximos, mas os abertos ficam como estão.
    let aplicar = aplicarEmAbertos;
    if (aplicar && slot && (await this.status(slot)).logada === false) {
      this.options.log?.(
        l10n.t('account {0} not signed in: open agents will not switch', String(slot)),
      );
      aplicar = false;
    }
    await this.setActive(slot);
    let sessoes: string[] = [];
    if (aplicar && this.options.onSwitch) {
      try {
        sessoes = await this.options.onSwitch(slot);
      } catch (error) {
        this.options.log?.(l10n.t('account switch on open agents failed: {0}', String(error)));
      }
    }
    const data: ClaudeAccountEventData = {
      ...(slot ? { ativa: slot, dir: this.dir(slot) } : {}),
      env: slot ? this.env(slot) : {},
      sessoes,
    };
    this.options.publish?.(data);
    return data;
  }

  /** Sai da conta pelo próprio CLI, que apaga o que guardou na pasta do slot. */
  async logout(slot: ClaudeAccountSlot): Promise<void> {
    const result = await (this.options.runClaude ?? defaultRunner)(['auth', 'logout'], {
      ...this.env(slot),
    });
    if (result.code !== 0) {
      this.options.log?.(
        l10n.t(
          'claude auth logout (account {0}) exited with {1}',
          String(slot),
          String(result.code),
        ),
      );
      throw new Error(
        l10n.t('could not sign out of the account; check that Claude Code is installed'),
      );
    }
  }

  async status(slot: ClaudeAccountSlot): Promise<ClaudeAuthStatus> {
    try {
      const result = await (this.options.runClaude ?? defaultRunner)(['auth', 'status'], {
        ...this.env(slot),
      });
      return parseAuthStatus(result.stdout);
    } catch {
      return {};
    }
  }

  async list(): Promise<ClaudeAccountsState> {
    await this.load();
    const usage = this.options.usage?.() ?? {};
    const contas: ClaudeAccountInfo[] = await Promise.all(
      CLAUDE_ACCOUNT_SLOTS.map(async (slot) => {
        const status = await this.status(slot);
        return {
          slot,
          apelido: this.nickname(slot),
          dir: this.dir(slot),
          ...status,
          ativa: this.state.ativa === slot,
          uso: usage[slot] ?? NO_USAGE,
        };
      }),
    );
    return {
      ...(this.state.ativa ? { ativa: this.state.ativa } : {}),
      contas,
      compartilhada: this.sharedProjects(),
      atribuicao: this.attributionFile(),
    };
  }

  register(router: Router): void {
    router.register('claude.accounts.list', () => this.list());
    router.register('claude.accounts.prepare', (params) => this.prepare(slotParam(params)));
    router.register('claude.accounts.rename', async (params) => {
      const p = objectParams(params);
      if (typeof p.apelido !== 'string') {
        throw RpcError.invalidParams(l10n.t('{0} must be text', 'apelido'));
      }
      await this.rename(slotParam(params), p.apelido);
      return this.list();
    });
    router.register('claude.accounts.setActive', async (params) => {
      const p = objectParams(params) as Partial<
        Record<keyof ClaudeAccountSetActiveParams, unknown>
      >;
      if (p.aplicarEmAbertos !== undefined && typeof p.aplicarEmAbertos !== 'boolean') {
        throw RpcError.invalidParams(l10n.t('{0} must be a boolean', 'aplicarEmAbertos'));
      }
      await this.activate(
        p.slot === null ? undefined : slotParam(params),
        p.aplicarEmAbertos !== false,
      );
      // Outras ativações podem ter chegado depois: devolve o estado de quando todas terminaram.
      await this.activated();
      return this.list();
    });
    router.register('claude.accounts.logout', async (params) => {
      try {
        await this.logout(slotParam(params));
      } catch (error) {
        throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
      }
      return this.list();
    });
  }
}

export function slotParam(params: unknown): ClaudeAccountSlot {
  const slot = objectParams(params).slot;
  if (!isClaudeAccountSlot(slot)) {
    throw RpcError.invalidParams(
      l10n.t('{0} must be {1}', 'slot', CLAUDE_ACCOUNT_SLOTS.join(', ')),
    );
  }
  return slot;
}
