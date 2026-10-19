import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { createServer, connect } from 'node:net';

import type { SshForwardInfo, SshForwardState, SshHostInfo } from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

import { RpcError } from '../rpc/router.js';
import { readJson, writeJsonAtomic } from '../store.js';

/*
 * Encaminhamento de porta no SSH nativo (RF-504, SDD 11.2): o Core mantém um
 * `ssh -N -L 127.0.0.1:<local>:<destino>:<porta> <host>` por encaminhamento.
 * O comando é uma lista de argumentos (sem shell) montada só depois de validar
 * host, destino e portas; o bind é sempre de loopback.
 */

/** Teto padrão de encaminhamentos ao mesmo tempo. */
export const MAX_FORWARDS = 8;
const LOOPBACK = '127.0.0.1';
const MAX_RECONNECTS = 5;
const READY_TIMEOUT_MS = 25_000;
const READY_POLL_MS = 200;
const CLOSE_GRACE_MS = 3000;
const STDERR_CHARS = 400;

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Endereço de servidor: nome ou IPv4, nunca começando com `-` nem com `:`/`@`/barra. */
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
/** IPv6 literal, entre colchetes como o `-L` exige. */
const IPV6 = /^\[[0-9A-Fa-f:.]{2,45}\]$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** Hostname do host manual: também aceita IPv6 sem colchetes (vai como destino do ssh). */
const TARGET = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|[0-9A-Fa-f:.]{2,45})$/;

export interface ForwardSpec {
  /** Alias de um host do inventário. */
  readonly host: string;
  readonly portaLocal: number;
  /** Endereço do destino, visto do servidor. Padrão `127.0.0.1`. */
  readonly destino: string;
  readonly portaDestino: number;
  readonly reconectar: boolean;
}

/** Porta TCP de 1 a 65535, de um número ou de um texto só com dígitos. */
export function parsePort(value: unknown, name: string): number {
  const port =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]{1,5}$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw RpcError.invalidParams(l10n.t('{0} must be a port from 1 to 65535', name));
  }
  return port;
}

/** Destino do `-L`, visto do servidor: um nome, IPv4 ou IPv6 entre colchetes. */
export function parseDestination(value: unknown): string {
  if (value === undefined || value === null || value === '') return LOOPBACK;
  if (typeof value !== 'string' || !(HOSTNAME.test(value) || IPV6.test(value))) {
    throw RpcError.invalidParams(l10n.t('destino must be a host name or IP address'));
  }
  return value;
}

/** Valida o pedido da IDE e devolve a especificação, ou recusa com a razão. */
export function parseForwardSpec(p: Record<string, unknown>): ForwardSpec {
  const host = p.host;
  if (typeof host !== 'string' || !ALIAS.test(host)) {
    throw RpcError.invalidParams(l10n.t('host must be the alias of a host in the SSH inventory'));
  }
  if (p.reconectar !== undefined && typeof p.reconectar !== 'boolean') {
    throw RpcError.invalidParams(l10n.t('{0} must be true or false', 'reconectar'));
  }
  return {
    host,
    portaLocal: parsePort(p.portaLocal, 'portaLocal'),
    destino: parseDestination(p.destino),
    portaDestino: parsePort(p.portaDestino, 'portaDestino'),
    reconectar: p.reconectar === true,
  };
}

/**
 * Argumentos do `ssh` de um encaminhamento. Recusa host com endereço ou usuário fora do
 * padrão (um valor começando com `-` viraria opção do ssh) e põe `--` antes do destino.
 * Sem multiplexação: o `-N` precisa ficar preso ao próprio processo para ser encerrado.
 */
export function buildForwardArgs(
  host: SshHostInfo,
  spec: ForwardSpec,
  identityPath: (path: string) => string = (path) => path,
): string[] {
  if (!ALIAS.test(host.alias)) {
    throw RpcError.invalidParams(l10n.t('host alias {0} has invalid characters', host.alias));
  }
  const manual = host.origem !== 'config';
  if (manual) {
    if (!host.hostname || !TARGET.test(host.hostname)) {
      throw RpcError.invalidParams(
        l10n.t('host {0} has an invalid address for forwarding', host.alias),
      );
    }
    if (host.user !== undefined && !USER.test(host.user)) {
      throw RpcError.invalidParams(l10n.t('host {0} has an invalid user', host.alias));
    }
    if (host.port !== undefined && !(Number.isInteger(host.port) && host.port >= 1)) {
      throw RpcError.invalidParams(l10n.t('host {0} has an invalid port', host.alias));
    }
  }
  return [
    '-N',
    '-T',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-L',
    `${LOOPBACK}:${String(spec.portaLocal)}:${spec.destino}:${String(spec.portaDestino)}`,
    ...(manual
      ? [
          '-o',
          'StrictHostKeyChecking=accept-new',
          ...(host.port ? ['-p', String(host.port)] : []),
          ...(host.user ? ['-l', host.user] : []),
          ...(host.identityFile ? ['-i', identityPath(host.identityFile)] : []),
        ]
      : []),
    '--',
    manual ? (host.hostname ?? host.alias) : host.alias,
  ];
}

/** O que o gerenciador usa de um processo: `ChildProcess` serve, e os testes trocam. */
export type ForwardChild = EventEmitter & {
  kill(signal?: NodeJS.Signals): boolean;
  readonly stderr?: EventEmitter | null;
};

export type ForwardSpawn = (command: string, args: readonly string[]) => ForwardChild;

export interface FavoriteForward {
  readonly host: string;
  readonly portaLocal: number;
  readonly destino: string;
  readonly portaDestino: number;
  readonly reconectar: boolean;
}

interface StoredForwards {
  readonly favoritos: FavoriteForward[];
}

export interface ForwardOptions {
  /** Resolve o alias no inventário e monta os argumentos do ssh. */
  readonly resolve: (spec: ForwardSpec) => Promise<{ command: string; args: string[] }>;
  /** Estado mudou: o Core publica o evento `ssh.forward`. */
  readonly emit?: (info: SshForwardInfo) => void;
  /** Arquivo dos favoritos; sem ele, nada é guardado. */
  readonly file?: string;
  readonly max?: number;
  readonly redact?: (text: string) => string;
  readonly log?: (message: string) => void;
  /** Testes: processo falso, sonda da porta, teste de porta livre e espera da reconexão. */
  readonly spawn?: ForwardSpawn;
  readonly probe?: (port: number) => Promise<boolean>;
  readonly isFree?: (port: number) => Promise<boolean>;
  readonly retryDelayMs?: (attempt: number) => number;
  readonly readyTimeoutMs?: number;
}

interface Entry {
  info: SshForwardInfo;
  readonly spec: ForwardSpec;
  child?: ForwardChild | undefined;
  closing: boolean;
  timer?: NodeJS.Timeout | undefined;
  stderr: string;
  /** Conclui a primeira tentativa: ok ou a razão da falha. */
  settle?: ((error?: string) => void) | undefined;
}

const defaultSpawn: ForwardSpawn = (command, args) =>
  spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

/** Há algo escutando na porta local do encaminhamento? */
function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: LOOPBACK });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, LOOPBACK, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Processos `ssh -N -L` do Core: abrir, listar e fechar, com limite de simultâneos,
 * reconexão opcional, estado em eventos e favoritos guardados. Nada reabre sozinho ao
 * iniciar o Core: um favorito só volta quando a IDE manda abrir de novo.
 */
export class ForwardManager {
  private readonly entries = new Map<string, Entry>();
  private favorites: FavoriteForward[] = [];
  private readonly spawnChild: ForwardSpawn;
  private readonly probe: (port: number) => Promise<boolean>;
  private readonly isFree: (port: number) => Promise<boolean>;
  private disposed = false;

  constructor(private readonly options: ForwardOptions) {
    this.spawnChild = options.spawn ?? defaultSpawn;
    this.probe = options.probe ?? tcpProbe;
    this.isFree = options.isFree ?? portIsFree;
  }

  async load(): Promise<void> {
    if (!this.options.file) return;
    const stored = await readJson<StoredForwards>(this.options.file);
    this.favorites = (stored?.favoritos ?? []).filter(
      (f) =>
        ALIAS.test(f.host) &&
        Number.isInteger(f.portaLocal) &&
        Number.isInteger(f.portaDestino) &&
        f.portaLocal >= 1 &&
        f.portaLocal <= 65_535 &&
        f.portaDestino >= 1 &&
        f.portaDestino <= 65_535,
    );
  }

  private async saveFavorites(): Promise<void> {
    if (this.options.file) {
      await writeJsonAtomic(this.options.file, { favoritos: this.favorites });
    }
  }

  list(): SshForwardInfo[] {
    const result = [...this.entries.values()].map((e) => e.info);
    for (const fav of this.favorites) {
      const id = forwardId(fav.host, fav.portaLocal);
      if (!this.entries.has(id)) result.push(this.infoOf(fav, 'fechado', true));
    }
    return result.sort((a, b) => a.portaLocal - b.portaLocal);
  }

  private infoOf(
    spec: ForwardSpec | FavoriteForward,
    estado: SshForwardState,
    favorito: boolean,
    extra: Partial<SshForwardInfo> = {},
  ): SshForwardInfo {
    return {
      id: forwardId(spec.host, spec.portaLocal),
      host: spec.host,
      bind: LOOPBACK,
      portaLocal: spec.portaLocal,
      destino: spec.destino,
      portaDestino: spec.portaDestino,
      estado,
      reconectar: spec.reconectar,
      favorito,
      tentativas: 0,
      url: `http://${LOOPBACK}:${String(spec.portaLocal)}`,
      ...extra,
    };
  }

  private isFavorite(host: string, port: number): boolean {
    return this.favorites.some((f) => f.host === host && f.portaLocal === port);
  }

  private set(entry: Entry, estado: SshForwardState, extra: Partial<SshForwardInfo> = {}): void {
    const i = entry.info;
    entry.info = {
      id: i.id,
      host: i.host,
      bind: i.bind,
      portaLocal: i.portaLocal,
      destino: i.destino,
      portaDestino: i.portaDestino,
      reconectar: i.reconectar,
      tentativas: i.tentativas,
      url: i.url,
      ...(i.desde ? { desde: i.desde } : {}),
      estado,
      favorito: this.isFavorite(entry.spec.host, entry.spec.portaLocal),
      ...extra,
    };
    this.options.emit?.(entry.info);
  }

  /** Abre um encaminhamento; devolve quando está ativo ou lança a razão da falha. */
  async open(spec: ForwardSpec, favorite: boolean): Promise<SshForwardInfo> {
    if (this.disposed) throw RpcError.invalidParams(l10n.t('the Core is shutting down'));
    const id = forwardId(spec.host, spec.portaLocal);
    const running = [...this.entries.values()].filter((e) => e.info.estado !== 'erro');
    const sameId = this.entries.get(id);
    if (sameId && sameId.info.estado !== 'erro') {
      throw RpcError.invalidParams(
        l10n.t('local port {0} is already forwarded to {1}', String(spec.portaLocal), spec.host),
      );
    }
    if (
      [...this.entries.values()].some(
        (e) => e.spec.portaLocal === spec.portaLocal && e.info.estado !== 'erro',
      )
    ) {
      throw RpcError.invalidParams(
        l10n.t('local port {0} is already used by another forward', String(spec.portaLocal)),
      );
    }
    const max = this.options.max ?? MAX_FORWARDS;
    if (running.length >= max) {
      throw RpcError.invalidParams(
        l10n.t('at most {0} forwards at the same time; close one first', String(max)),
      );
    }
    // Resolve antes de tocar em qualquer coisa: host fora do inventário ou inválido para aqui.
    const command = await this.options.resolve(spec);
    if (!(await this.isFree(spec.portaLocal))) {
      throw RpcError.invalidParams(
        l10n.t('local port {0} is already in use on this machine', String(spec.portaLocal)),
      );
    }
    if (favorite) await this.rememberFavorite(spec);
    const entry: Entry = {
      info: this.infoOf(spec, 'abrindo', favorite || this.isFavorite(spec.host, spec.portaLocal)),
      spec,
      closing: false,
      stderr: '',
    };
    this.entries.set(id, entry);
    this.options.emit?.(entry.info);
    const failure = await new Promise<string | undefined>((resolve) => {
      entry.settle = resolve;
      this.launch(entry, command);
    });
    entry.settle = undefined;
    if (failure !== undefined) {
      // A primeira tentativa que falha não deixa encaminhamento parado na lista.
      this.entries.delete(id);
      this.options.emit?.({ ...entry.info, estado: 'erro', erro: failure });
      throw RpcError.invalidParams(failure);
    }
    return entry.info;
  }

  private async rememberFavorite(spec: ForwardSpec): Promise<void> {
    const fav: FavoriteForward = {
      host: spec.host,
      portaLocal: spec.portaLocal,
      destino: spec.destino,
      portaDestino: spec.portaDestino,
      reconectar: spec.reconectar,
    };
    this.favorites = [
      ...this.favorites.filter((f) => !(f.host === fav.host && f.portaLocal === fav.portaLocal)),
      fav,
    ];
    await this.saveFavorites();
  }

  private launch(entry: Entry, command: { command: string; args: string[] }): void {
    entry.stderr = '';
    let exited = false;
    let child: ForwardChild;
    try {
      child = this.spawnChild(command.command, command.args);
    } catch (error) {
      this.afterExit(entry, command, error instanceof Error ? error.message : String(error));
      return;
    }
    entry.child = child;
    child.stderr?.on('data', (chunk: Buffer | string) => {
      entry.stderr = (entry.stderr + chunk.toString()).slice(-STDERR_CHARS);
    });
    const onExit = (reason: string): void => {
      if (exited) return;
      exited = true;
      entry.child = undefined;
      this.afterExit(entry, command, reason);
    };
    child.on('error', (error: Error) => {
      onExit(error.message);
    });
    child.on('exit', (code: number | null, signal: string | null) => {
      onExit(
        code === null ? (signal ?? 'terminated') : l10n.t('ssh ended with code {0}', String(code)),
      );
    });
    void this.waitReady(entry, () => exited);
  }

  /** Pedido de fechar (ou Core fechando) que chegou enquanto algo esperava. */
  private isClosing(entry: Entry): boolean {
    return entry.closing || this.disposed;
  }

  /** Sonda a porta local até o ssh escutar nela, o processo cair ou o prazo acabar. */
  private async waitReady(entry: Entry, exited: () => boolean): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    while (!exited() && !entry.closing && !this.disposed) {
      if (await this.probe(entry.spec.portaLocal)) {
        // O processo pode ter caído enquanto a sonda rodava (porta de outro programa).
        if (exited() || this.isClosing(entry)) return;
        this.set(entry, 'ativo', { desde: new Date().toISOString(), tentativas: 0 });
        entry.settle?.();
        return;
      }
      if (Date.now() >= deadline) {
        entry.stderr = l10n.t('timed out waiting for the tunnel to open');
        entry.child?.kill();
        return;
      }
      await sleep(READY_POLL_MS);
    }
  }

  private message(entry: Entry, reason: string): string {
    const detail = entry.stderr.trim();
    const text = detail ? `${reason}: ${detail}` : reason;
    return this.options.redact?.(text) ?? text;
  }

  private afterExit(
    entry: Entry,
    command: { command: string; args: string[] },
    reason: string,
  ): void {
    const id = entry.info.id;
    if (entry.closing || this.disposed) {
      this.entries.delete(id);
      this.options.emit?.({ ...entry.info, estado: 'fechado' });
      return;
    }
    const wasFirstAttempt = entry.info.estado === 'abrindo';
    if (wasFirstAttempt) {
      entry.settle?.(this.message(entry, reason));
      return;
    }
    const attempt = entry.info.tentativas + 1;
    if (entry.spec.reconectar && attempt <= MAX_RECONNECTS) {
      this.set(entry, 'reconectando', { tentativas: attempt });
      const delay = this.options.retryDelayMs?.(attempt) ?? Math.min(30_000, 1000 * 2 ** attempt);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (entry.closing || this.disposed) return;
        this.launch(entry, command);
      }, delay);
      entry.timer.unref();
      return;
    }
    this.set(entry, 'erro', { erro: this.message(entry, reason) });
    this.options.log?.(l10n.t('forward {0} ended: {1}', id, entry.info.erro ?? reason));
  }

  /** Fecha um encaminhamento (ativo, reconectando ou com erro); `forget` tira dos favoritos. */
  async close(id: string, forget: boolean): Promise<SshForwardInfo[]> {
    const entry = this.entries.get(id);
    const favorite = this.favorites.find((f) => forwardId(f.host, f.portaLocal) === id);
    if (!entry && !favorite) {
      throw RpcError.notFound(l10n.t('forward {0} does not exist', id));
    }
    if (forget && favorite) {
      this.favorites = this.favorites.filter((f) => f !== favorite);
      await this.saveFavorites();
    }
    if (entry) await this.stop(entry);
    return this.list();
  }

  private async stop(entry: Entry): Promise<void> {
    entry.closing = true;
    clearTimeout(entry.timer);
    const child = entry.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, CLOSE_GRACE_MS);
        child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
        child.kill();
      });
    }
    entry.settle?.(l10n.t('closed'));
    if (this.entries.delete(entry.info.id)) {
      this.options.emit?.({ ...entry.info, estado: 'fechado' });
    }
  }

  /** Ao fechar o Core: encerra todos os processos; os favoritos ficam para a próxima vez. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.entries.values()].map((entry) => this.stop(entry)));
  }
}

export function forwardId(host: string, port: number): string {
  return `${host}:${String(port)}`;
}
