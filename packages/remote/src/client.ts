import { l10n } from '@fakl/i18n';

import {
  CHANNEL_VERSION,
  ChannelError,
  decodeKey,
  deriveChannel,
  encodeKey,
  generateKeyPair,
  parseFrame,
  type DeviceHello,
  type KeyPair,
  type PlainError,
  type SecureChannel,
} from './channel.js';
import { relaySocketUrl } from './pairing.js';
import type { RemoteScope } from './scopes.js';

/** Onde e com quem o aparelho fala. */
export interface DeviceTarget {
  /** Endereço HTTPS do relay. */
  readonly relay: string;
  readonly machine: string;
  /** Chave pública fixa do Core (base64url), vinda do QR. */
  readonly coreKey: string;
}

export class RemoteError extends Error {
  override readonly name = 'RemoteError';

  constructor(
    readonly motivo: PlainError['motivo'] | 'recusado' | 'fechado' | 'tempo',
    message: string,
  ) {
    super(message);
  }
}

/** O texto de cada motivo, no idioma do momento (por isso uma função, não uma constante). */
function message(motivo: RemoteError['motivo']): string {
  switch (motivo) {
    case 'offline':
      return l10n.t('The IDE is not open on this machine (or remote access is turned off).');
    case 'desconhecido':
      return l10n.t('This device is no longer paired. Pair it again with the QR code.');
    case 'codigo':
      return l10n.t('The QR code expired or was already used. Generate another one in the IDE.');
    case 'versao':
      return l10n.t('The app and the IDE are on different versions. Reload the page.');
    case 'protocolo':
      return l10n.t('Protocol error.');
    case 'revogado':
      return l10n.t('This device was revoked in the IDE.');
    case 'recusado':
      return l10n.t('Pairing was declined in the IDE.');
    case 'fechado':
      return l10n.t('Connection closed.');
    case 'tempo':
      return l10n.t('The IDE did not respond in time.');
  }
}

function remoteError(motivo: RemoteError['motivo']): RemoteError {
  return new RemoteError(motivo, message(motivo));
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Erro devolvido por um método do Core. */
export class RemoteRpcError extends Error {
  override readonly name = 'RemoteRpcError';

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type SocketFactory = (url: string) => WebSocket;

async function open(
  target: DeviceTarget,
  mine: KeyPair,
  mode: DeviceHello['modo'],
  code: string | undefined,
  factory: SocketFactory,
  timeoutMs: number,
): Promise<{ socket: WebSocket; channel: SecureChannel; inbox: AsyncQueue }> {
  const socket = factory(
    relaySocketUrl(target.relay, '/device', `?m=${encodeURIComponent(target.machine)}`),
  );
  const inbox = new AsyncQueue();
  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') inbox.push(event.data);
  });
  socket.addEventListener('close', () => {
    inbox.close();
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(remoteError('offline'));
    });
  });
  const ephemeral = await generateKeyPair();
  const hello: DeviceHello = {
    t: 'hello',
    v: CHANNEL_VERSION,
    modo: mode,
    dev: encodeKey(mine.raw),
    eph: encodeKey(ephemeral.raw),
  };
  socket.send(JSON.stringify(hello));
  const first = await inbox.next(timeoutMs);
  if (first === undefined) throw remoteError(inbox.closed ? 'offline' : 'tempo');
  const frame = parseFrame(first);
  if (frame.t === 'erro') {
    socket.close();
    throw remoteError(frame.motivo);
  }
  if (frame.t !== 'hello') throw remoteError('protocolo');
  const channel = await deriveChannel({
    role: 'aparelho',
    mode,
    mine,
    ephemeral,
    peerStatic: decodeKey(target.coreKey),
    peerEphemeral: decodeKey(frame.eph),
    ...(code ? { code } : {}),
  });
  return { socket, channel, inbox };
}

/** Fila de mensagens do WebSocket, lida em ordem com `await`. */
class AsyncQueue {
  private readonly items: string[] = [];
  private waiter: ((value: string | undefined) => void) | undefined;
  closed = false;

  push(item: string): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    this.waiter?.(undefined);
    this.waiter = undefined;
  }

  next(timeoutMs?: number): Promise<string | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter = resolve;
      if (timeoutMs !== undefined) {
        setTimeout(() => {
          if (this.waiter === resolve) {
            this.waiter = undefined;
            resolve(undefined);
          }
        }, timeoutMs);
      }
    });
  }
}

export interface PairResult {
  readonly id: string;
  readonly escopos: readonly RemoteScope[];
}

const defaultFactory: SocketFactory = (url) => new WebSocket(url);

/**
 * Pareia este aparelho (SDD 12.2): prova o código do QR e espera a
 * confirmação na IDE. Depois, use `RemoteSession.connect` com as mesmas chaves.
 */
export async function pairDevice(
  target: DeviceTarget,
  mine: KeyPair,
  code: string,
  nome: string,
  options: { factory?: SocketFactory; timeoutMs?: number } = {},
): Promise<PairResult> {
  const { socket, channel, inbox } = await open(
    target,
    mine,
    'parear',
    code,
    options.factory ?? defaultFactory,
    15_000,
  );
  try {
    socket.send(await channel.seal({ t: 'parear', nome }));
    // A IDE pede confirmação a você; espera até 10 minutos e pouco.
    const text = await inbox.next(options.timeoutMs ?? 630_000);
    if (text === undefined) throw remoteError(inbox.closed ? 'codigo' : 'tempo');
    const frame = parseFrame(text);
    if (frame.t === 'erro') throw remoteError(frame.motivo);
    if (frame.t !== 'box') throw remoteError('protocolo');
    let answer: { t?: string; id?: string; escopos?: RemoteScope[] };
    try {
      answer = (await channel.open(frame)) as typeof answer;
    } catch (error) {
      if (error instanceof ChannelError) throw remoteError('codigo');
      throw error;
    }
    if (answer.t !== 'pareado' || typeof answer.id !== 'string') throw remoteError('recusado');
    return { id: answer.id, escopos: answer.escopos ?? [] };
  } finally {
    socket.close();
  }
}

/** Sessão autenticada de um aparelho pareado: a API do Core pelo canal cifrado. */
export class RemoteSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private readonly closeListeners = new Set<(error: RemoteError) => void>();
  private ended = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly channel: SecureChannel,
    inbox: AsyncQueue,
  ) {
    void this.pump(inbox);
  }

  static async connect(
    target: DeviceTarget,
    mine: KeyPair,
    options: { factory?: SocketFactory } = {},
  ): Promise<RemoteSession> {
    const { socket, channel, inbox } = await open(
      target,
      mine,
      'entrar',
      undefined,
      options.factory ?? defaultFactory,
      15_000,
    );
    return new RemoteSession(socket, channel, inbox);
  }

  private async pump(inbox: AsyncQueue): Promise<void> {
    let reason: RemoteError = remoteError('fechado');
    for (;;) {
      const text = await inbox.next();
      if (text === undefined) break;
      try {
        const frame = parseFrame(text);
        if (frame.t === 'erro') {
          reason = remoteError(frame.motivo);
          break;
        }
        if (frame.t !== 'box') continue;
        this.dispatch(await this.channel.open(frame));
      } catch {
        reason = remoteError('protocolo');
        break;
      }
    }
    this.end(reason);
  }

  private dispatch(message: unknown): void {
    const m = message as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (typeof m.method === 'string') {
      for (const listener of this.listeners) listener(m.method, m.params);
      return;
    }
    if (typeof m.id !== 'number') return;
    const pending = this.pending.get(m.id);
    if (!pending) return;
    this.pending.delete(m.id);
    if (m.error) pending.reject(new RemoteRpcError(m.error.code, m.error.message));
    else pending.resolve(m.result);
  }

  private end(reason: RemoteError): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    for (const listener of this.closeListeners) listener(reason);
    this.socket.close();
  }

  get closed(): boolean {
    return this.ended;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.ended) throw remoteError('fechado');
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject });
    });
    this.socket.send(
      await this.channel.seal({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
    return result;
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: RemoteError) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.end(remoteError('fechado'));
  }
}
