import { l10n } from '@fakl/i18n';
import {
  FaklErrorCode,
  JsonRpcErrorCode,
  type CoreMethod,
  type JsonRpcErrorCodeValue,
} from '@fakl/protocol';

/** Erro de método que vira uma resposta JSON-RPC com código e dados. */
export class RpcError extends Error {
  constructor(
    readonly code: JsonRpcErrorCodeValue,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  static invalidParams(message: string): RpcError {
    return new RpcError(JsonRpcErrorCode.InvalidParams, message);
  }

  static notFound(message: string): RpcError {
    return new RpcError(FaklErrorCode.NotFound, message);
  }
}

/** O que um método enxerga da conexão que o chamou. */
export interface CallContext {
  readonly connectionId: string;
  /** Sessão de agente que chamou, quando a conexão usa um token restrito. */
  readonly principal?: string | undefined;
  /** Envia uma notificação a esta conexão. */
  notify(method: string, params: unknown): void;
  /** Registra algo a liberar quando a conexão fechar. */
  onClose(cleanup: () => void): void;
}

export type Handler = (params: unknown, context: CallContext) => unknown;

export class Router {
  private readonly handlers = new Map<string, Handler>();

  register(method: CoreMethod, handler: Handler): this {
    if (this.handlers.has(method)) {
      throw new Error(l10n.t('method {0} already registered', method));
    }
    this.handlers.set(method, handler);
    return this;
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  async dispatch(method: string, params: unknown, context: CallContext): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, l10n.t('Unknown method: {0}', method));
    }
    return await handler(params, context);
  }
}

/** Lê um objeto de parâmetros, recusando o que não for objeto. */
export function objectParams(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw RpcError.invalidParams(l10n.t('params must be an object'));
  }
  return params as Record<string, unknown>;
}

export function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value === '') {
    throw RpcError.invalidParams(l10n.t('{0} must be non-empty text', name));
  }
  return value;
}

export function stringArrayParam(params: Record<string, unknown>, name: string): string[] {
  const value = params[name];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    throw RpcError.invalidParams(l10n.t('{0} must be a non-empty list of texts', name));
  }
  return value;
}
