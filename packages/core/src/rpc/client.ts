import { connect, type Socket } from 'node:net';

import { l10n } from '@fakl/i18n';
import {
  isFailure,
  isNotification,
  isResponse,
  JSONRPC_VERSION,
  PROTOCOL_VERSION,
  type ClientKind,
  type CoreMethod,
  type HelloResult,
  type JsonRpcErrorObject,
} from '@fakl/protocol';

import { encodeMessage, LineDecoder } from './framing.js';

export class CoreRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.name = 'CoreRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export type NotificationListener = (method: string, params: unknown) => void;

/**
 * Cliente da API local do Core, usado pela CLI, pelos testes e, por meio de
 * uma ponte, pelas extensões.
 */
export class CoreClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closedError: Error | undefined;
  private helloResult: HelloResult | undefined;

  private constructor(private readonly socket: Socket) {
    const decoder = new LineDecoder();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of decoder.push(chunk)) this.onLine(line);
    });
    socket.on('error', (error) => {
      this.fail(error);
    });
    socket.on('close', () => {
      this.fail(new Error(l10n.t('Connection to the Core closed')));
    });
  }

  /** Conecta e abre a sessão com o token. */
  static async connect(
    path: string,
    token: string,
    client: ClientKind = 'cli',
    options: { readonly locale?: string } = {},
  ): Promise<CoreClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(path);
      s.once('connect', () => {
        s.off('error', reject);
        resolve(s);
      });
      s.once('error', reject);
    });
    const instance = new CoreClient(socket);
    try {
      instance.helloResult = await instance.request<HelloResult>('session.hello', {
        token,
        client,
        protocolVersion: PROTOCOL_VERSION,
        ...(options.locale ? { locale: options.locale } : {}),
      });
    } catch (error) {
      instance.close();
      throw error;
    }
    return instance;
  }

  /** Resposta do session.hello: versão e pid do Core. */
  get hello(): HelloResult {
    if (!this.helloResult) throw new Error(l10n.t('session not open'));
    return this.helloResult;
  }

  request<TResult = unknown>(method: CoreMethod, params?: unknown): Promise<TResult> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          resolve(value as TResult);
        },
        reject,
      });
      this.socket.write(encodeMessage({ jsonrpc: JSONRPC_VERSION, id, method, params }));
    });
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Avisa quando a conexão cai ou é fechada. */
  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.end();
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (isNotification(message)) {
      for (const listener of this.listeners) listener(message.method, message.params);
      return;
    }
    if (!isResponse(message)) return;
    if (message.id === null) {
      // Erro sem id: o Core recusou a conexão inteira.
      if (isFailure(message)) this.fail(new CoreRpcError(message.error));
      return;
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) return;
    this.pending.delete(Number(message.id));
    if (isFailure(message)) {
      pending.reject(new CoreRpcError(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    const first = this.closedError === undefined;
    this.closedError ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (first) for (const listener of this.closeListeners) listener(error);
  }
}
