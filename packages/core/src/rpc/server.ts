import { timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import { l10n } from '@fakl/i18n';
import {
  failure,
  FaklErrorCode,
  isNotification,
  isRequest,
  JSONRPC_VERSION,
  JsonRpcErrorCode,
  PROTOCOL_VERSION,
  success,
  type HelloResult,
  type JsonRpcId,
} from '@fakl/protocol';

import { ulid } from '../ulid.js';
import { encodeMessage, LineDecoder } from './framing.js';
import { RpcError, type CallContext, type Router } from './router.js';

export interface RpcServerOptions {
  readonly router: Router;
  /** Token de sessão gerado pelo processo principal a cada inicialização. */
  readonly token: string;
  readonly coreVersion: string;
  readonly log?: (message: string) => void;
  /**
   * Tokens restritos, como o de cada maestro (SDD 9.1): quem conecta com eles
   * só chama os métodos listados, e os métodos sabem quem chamou.
   */
  readonly scopedToken?: (token: string) => ScopedAccess | undefined;
  /**
   * A IDE informou o idioma da interface no `session.hello`; devolve o idioma
   * que o Core passou a usar. Só vale para a extensão com o token de sessão.
   */
  readonly onLocale?: (locale: string) => string;
  /** Idioma atual do Core, informado no `session.hello`. */
  readonly locale?: () => string;
}

export interface ScopedAccess {
  /** Quem usa o token; para um agente, o id da sessão. */
  readonly principal: string;
  readonly methods: ReadonlySet<string>;
}

/** Uma conexão em processo: o dono entrega mensagens e fecha quando o canal cai. */
export interface AttachedConnection {
  receive(message: unknown): Promise<void>;
  close(): void;
}

function sameToken(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Servidor JSON-RPC do Core sobre socket Unix (macOS) ou named pipe (Windows).
 * Nada escuta em porta TCP (SDD 4.1). Toda conexão começa com `session.hello`
 * carregando o token; qualquer outra coisa antes disso fecha a conexão.
 */
export class RpcServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly attached = new Set<{ close(): void }>();

  constructor(private readonly options: RpcServerOptions) {}

  async listen(path: string): Promise<void> {
    const isPipe = path.startsWith('\\\\');
    if (!isPipe) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // Um socket que sobrou de uma execução que caiu impede o listen.
      await rm(path, { force: true });
    }
    const server = createServer((socket) => {
      this.handle(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (!isPipe) {
      // Só o próprio usuário pode falar com o Core (SDD 14.1).
      await chmod(path, 0o600);
    }
    this.server = server;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    for (const connection of this.attached) connection.close();
    this.attached.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Conexão já autenticada que não passa pelo socket, como a de um aparelho
   * do controle remoto (SDD 12): o canal cifrado entrega as mensagens aqui e
   * o escopo limita os métodos.
   */
  attach(scope: ScopedAccess, send: (message: unknown) => void): AttachedConnection {
    const connection = this.connection(send, scope);
    this.attached.add(connection);
    return {
      receive: (message) => connection.dispatch(message),
      close: () => {
        this.attached.delete(connection);
        connection.close();
      },
    };
  }

  private connection(
    send: (message: unknown) => void,
    initialScope?: ScopedAccess,
  ): {
    context: CallContext;
    setScope(scope: ScopedAccess | undefined): void;
    dispatch(message: unknown): Promise<void>;
    close(): void;
  } {
    const cleanups: (() => void)[] = [];
    let scope = initialScope;
    let closed = false;
    const context: CallContext = {
      connectionId: ulid(),
      get principal() {
        return scope?.principal;
      },
      notify: (method, params) => {
        if (!closed) send({ jsonrpc: JSONRPC_VERSION, method, params });
      },
      onClose: (cleanup) => cleanups.push(cleanup),
    };
    const reply = (message: unknown): void => {
      if (!closed) send(message);
    };
    return {
      context,
      setScope: (value) => {
        scope = value;
      },
      dispatch: async (message) => {
        if (isNotification(message)) {
          // O Core não espera notificações dos clientes; ignora sem responder.
          return;
        }
        if (!isRequest(message)) {
          reply(failure(null, JsonRpcErrorCode.InvalidRequest, l10n.t('Invalid JSON-RPC request')));
          return;
        }
        if (scope && !scope.methods.has(message.method)) {
          reply(
            failure(
              message.id,
              FaklErrorCode.Forbidden,
              l10n.t('{0} is not allowed', message.method),
            ),
          );
          return;
        }
        try {
          const result = await this.options.router.dispatch(
            message.method,
            message.params,
            context,
          );
          reply(success(message.id, result ?? null));
        } catch (error) {
          if (error instanceof RpcError) {
            // Recusas também vão para o log: é onde dá para ver, depois, por
            // que um agente não subiu.
            this.options.log?.(l10n.t('refused in {0}: {1}', message.method, error.message));
            reply(failure(message.id, error.code, error.message, error.data));
          } else {
            this.options.log?.(l10n.t('error in {0}: {1}', message.method, String(error)));
            reply(
              failure(message.id, JsonRpcErrorCode.InternalError, l10n.t('Internal Core error')),
            );
          }
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        for (const cleanup of cleanups) cleanup();
      },
    };
  }

  private handle(socket: Socket): void {
    const decoder = new LineDecoder();
    let authenticated = false;

    this.sockets.add(socket);
    socket.setEncoding('utf8');

    const send = (message: unknown): void => {
      if (!socket.destroyed) socket.write(encodeMessage(message));
    };
    const connection = this.connection(send);

    const reject = (
      id: JsonRpcId | null,
      code: typeof FaklErrorCode.Unauthorized,
      message: string,
    ): void => {
      send(failure(id, code, message));
      socket.end();
    };

    const onMessage = async (line: string): Promise<void> => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send(failure(null, JsonRpcErrorCode.ParseError, l10n.t('Invalid JSON')));
        return;
      }

      if (!authenticated) {
        if (!isRequest(message) || message.method !== 'session.hello') {
          reject(
            null,
            FaklErrorCode.Unauthorized,
            l10n.t('The connection must start with session.hello'),
          );
          return;
        }
        const params = message.params as
          { token?: unknown; client?: unknown; locale?: unknown } | undefined;
        if (!sameToken(this.options.token, params?.token)) {
          const scope =
            typeof params?.token === 'string'
              ? this.options.scopedToken?.(params.token)
              : undefined;
          if (!scope) {
            reject(message.id, FaklErrorCode.Unauthorized, l10n.t('Invalid token'));
            return;
          }
          connection.setScope(scope);
        } else if (params?.client === 'extension' && typeof params.locale === 'string') {
          this.options.onLocale?.(params.locale);
        }
        authenticated = true;
        const locale = this.options.locale?.();
        const result: HelloResult = {
          protocolVersion: PROTOCOL_VERSION,
          coreVersion: this.options.coreVersion,
          pid: process.pid,
          ...(locale ? { locale } : {}),
        };
        send(success(message.id, result));
        return;
      }
      await connection.dispatch(message);
    };

    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        send(failure(null, JsonRpcErrorCode.InvalidRequest, String(error)));
        socket.destroy();
        return;
      }
      for (const line of lines) void onMessage(line);
    });
    socket.on('error', () => {
      // Desconexão abrupta do cliente; o 'close' faz a limpeza.
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      connection.close();
    });
  }
}
