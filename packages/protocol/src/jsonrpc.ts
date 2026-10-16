/**
 * Tipos e utilitários de JSON-RPC 2.0 (https://www.jsonrpc.org/specification),
 * o formato de todas as chamadas à API local do Core (SDD 4.1 e 6.3).
 */

export const JSONRPC_VERSION = '2.0';

export type JsonRpcId = string | number;

export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcErrorObject<TData = unknown> {
  readonly code: number;
  readonly message: string;
  readonly data?: TData;
}

export interface JsonRpcSuccess<TResult = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: TResult;
}

export interface JsonRpcFailure<TData = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorObject<TData>;
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcFailure;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Códigos reservados pela especificação. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * Códigos próprios do Core, na faixa reservada a servidores (-32000 a -32099).
 */
export const FaklErrorCode = {
  Unauthorized: -32001,
  Forbidden: -32002,
  NotFound: -32003,
  Conflict: -32004,
  LimitExceeded: -32005,
  ProviderUnavailable: -32006,
} as const;

export type JsonRpcErrorCodeValue =
  | (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode]
  | (typeof FaklErrorCode)[keyof typeof FaklErrorCode];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function hasVersion(value: Record<string, unknown>): boolean {
  return value.jsonrpc === JSONRPC_VERSION;
}

export function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    hasVersion(value) &&
    typeof value.method === 'string' &&
    'id' in value &&
    isId(value.id)
  );
}

export function isNotification(value: unknown): value is JsonRpcNotification {
  return (
    isRecord(value) && hasVersion(value) && typeof value.method === 'string' && !('id' in value)
  );
}

export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || !hasVersion(value) || 'method' in value) {
    return false;
  }
  const hasResult = 'result' in value;
  const hasError = 'error' in value;
  if (hasResult === hasError) {
    return false;
  }
  if (hasResult) {
    return isId(value.id);
  }
  return (
    (value.id === null || isId(value.id)) &&
    isRecord(value.error) &&
    typeof value.error.code === 'number' &&
    typeof value.error.message === 'string'
  );
}

export function isFailure(response: JsonRpcResponse): response is JsonRpcFailure {
  return 'error' in response;
}

export function success<TResult>(id: JsonRpcId, result: TResult): JsonRpcSuccess<TResult> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function failure<TData>(
  id: JsonRpcId | null,
  code: JsonRpcErrorCodeValue,
  message: string,
  data?: TData,
): JsonRpcFailure<TData> {
  const error: JsonRpcErrorObject<TData> =
    data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: JSONRPC_VERSION, id, error };
}
