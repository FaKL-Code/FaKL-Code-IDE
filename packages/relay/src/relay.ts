import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { Duplex } from 'node:stream';

import {
  MACHINE_ID,
  machineIdFromSecret,
  type CoreToRelay,
  type PlainError,
  type PushMessage,
  type PushSubscriptionData,
  type RelayToCore,
} from '@fakl/remote';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { l10n } from '@fakl/i18n';

/** Envia uma notificação Web Push; devolve o status HTTP do serviço de push. */
export type PushSender = (sub: PushSubscriptionData, message: PushMessage) => Promise<number>;

export interface RelayOptions {
  readonly server: Server;
  /** Pasta do PWA; sem ela, o relay só repassa. */
  readonly staticDir?: string;
  /** Se definida, o Core precisa apresentá-la (FAKL_RELAY_KEY). */
  readonly accessKey?: string;
  /** Chave pública VAPID, entregue ao PWA para assinar o push. */
  readonly vapidPublicKey?: string;
  readonly push?: PushSender;
  readonly log?: (message: string) => void;
  /** Canais simultâneos por máquina. */
  readonly maxChannels?: number;
  /** Conexões de aparelho por IP por minuto. */
  readonly connectionsPerMinute?: number;
}

export interface Relay {
  /** Máquinas com o Core conectado agora. */
  readonly machines: ReadonlySet<string>;
  close(): Promise<void>;
}

const MAX_PAYLOAD = 1024 * 1024;
const PING_MS = 30_000;
const AUTH_TIMEOUT_MS = 10_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000',
};

function sameSecret(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function text(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

interface Machine {
  readonly id: string;
  readonly socket: WebSocket;
  readonly channels: Map<string, WebSocket>;
}

/**
 * Relay do controle remoto (SDD 12.1). O Core abre `/core` e se autentica com
 * o segredo da máquina; cada aparelho abre `/device?m=<máquina>` e vira um
 * canal multiplexado na conexão do Core. O relay não tem chaves: os aparelhos
 * e o Core cifram de ponta a ponta.
 */
export function createRelay(options: RelayOptions): Relay {
  const log = options.log ?? (() => undefined);
  const machines = new Map<string, Machine>();
  const maxChannels = options.maxChannels ?? 20;
  const perMinute = options.connectionsPerMinute ?? 30;
  const attempts = new Map<string, { count: number; since: number }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  const toCore = (machine: Machine, frame: RelayToCore): void => {
    if (machine.socket.readyState === WebSocket.OPEN) machine.socket.send(JSON.stringify(frame));
  };

  const limited = (ip: string): boolean => {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.since > 60_000) {
      attempts.set(ip, { count: 1, since: now });
      return false;
    }
    entry.count++;
    return entry.count > perMinute;
  };

  const onCore = (socket: WebSocket): void => {
    let machine: Machine | undefined;
    const timer = setTimeout(() => {
      socket.close(4401, l10n.t('no authentication'));
    }, AUTH_TIMEOUT_MS);
    socket.on('message', (data) => {
      void (async () => {
        let frame: CoreToRelay;
        try {
          frame = JSON.parse(text(data)) as CoreToRelay;
        } catch {
          socket.close(4400, l10n.t('invalid frame'));
          return;
        }
        if (!machine) {
          if (frame.t !== 'auth' || typeof frame.m !== 'string' || typeof frame.s !== 'string') {
            socket.close(4401, l10n.t('authenticate first'));
            return;
          }
          if (options.accessKey && !sameSecret(options.accessKey, frame.k)) {
            socket.send(
              JSON.stringify({ t: 'recusado', motivo: 'chave do relay' } satisfies RelayToCore),
            );
            socket.close(4403, 'chave do relay');
            return;
          }
          if (!MACHINE_ID.test(frame.m) || (await machineIdFromSecret(frame.s)) !== frame.m) {
            socket.send(JSON.stringify({ t: 'recusado', motivo: 'segredo' } satisfies RelayToCore));
            socket.close(4403, 'segredo');
            return;
          }
          clearTimeout(timer);
          // Um Core novo da mesma máquina substitui o anterior.
          const previous = machines.get(frame.m);
          if (previous)
            previous.socket.close(4409, l10n.t('another connection from the same machine'));
          machine = { id: frame.m, socket, channels: new Map() };
          machines.set(frame.m, machine);
          socket.send(
            JSON.stringify({
              t: 'ok',
              ...(options.vapidPublicKey ? { vapid: options.vapidPublicKey } : {}),
            } satisfies RelayToCore),
          );
          log(l10n.t('core connected: {0}', frame.m));
          return;
        }
        switch (frame.t) {
          case 'data': {
            const device = machine.channels.get(frame.ch);
            if (device?.readyState === WebSocket.OPEN) device.send(frame.d);
            break;
          }
          case 'close':
            machine.channels.get(frame.ch)?.close(1000, l10n.t('closed by the Core'));
            machine.channels.delete(frame.ch);
            break;
          case 'push': {
            const current = machine;
            if (!options.push) {
              toCore(current, { t: 'push', id: frame.id, ok: false });
              break;
            }
            options
              .push(frame.sub, frame.msg)
              .then((status) => {
                toCore(current, {
                  t: 'push',
                  id: frame.id,
                  ok: status >= 200 && status < 300,
                  ...(status === 404 || status === 410 ? { expirada: true } : {}),
                });
              })
              .catch((error: unknown) => {
                const status = (error as { statusCode?: number }).statusCode;
                toCore(current, {
                  t: 'push',
                  id: frame.id,
                  ok: false,
                  ...(status === 404 || status === 410 ? { expirada: true } : {}),
                });
              });
            break;
          }
          default:
            break;
        }
      })();
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (machine && machines.get(machine.id) === machine) {
        machines.delete(machine.id);
        for (const device of machine.channels.values())
          device.close(4404, l10n.t('machine offline'));
        log(l10n.t('core disconnected: {0}', machine.id));
      }
    });
  };

  const onDevice = (socket: WebSocket, machineId: string): void => {
    const machine = machines.get(machineId);
    if (!machine) {
      socket.send(JSON.stringify({ t: 'erro', motivo: 'offline' } satisfies PlainError));
      socket.close(4404, l10n.t('machine offline'));
      return;
    }
    if (machine.channels.size >= maxChannels) {
      socket.close(4429, l10n.t('too many devices'));
      return;
    }
    const ch = randomUUID();
    machine.channels.set(ch, socket);
    toCore(machine, { t: 'open', ch });
    socket.on('message', (data) => {
      toCore(machine, { t: 'data', ch, d: text(data) });
    });
    socket.on('close', () => {
      if (machine.channels.delete(ch)) toCore(machine, { t: 'close', ch });
    });
  };

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://relay');
    const path = url.pathname.replace(/\/+$/, '');
    const ip = request.socket.remoteAddress ?? '?';
    if (path.endsWith('/core')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        onCore(ws);
      });
    } else if (path.endsWith('/device')) {
      const machine = url.searchParams.get('m') ?? '';
      if (!MACHINE_ID.test(machine) || limited(ip)) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        onDevice(ws, machine);
      });
    } else {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    }
  };

  const serveStatic = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://relay');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    if (url.pathname.endsWith('/saude')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname.endsWith('/vapid.json')) {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ chave: options.vapidPublicKey ?? null }));
      return;
    }
    const root = options.staticDir;
    if (!root || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404).end();
      return;
    }
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(root, relative);
    if (!file.startsWith(normalize(root + sep)) && file !== normalize(root)) {
      response.writeHead(403).end();
      return;
    }
    let info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) {
      // Rotas do PWA voltam para o index.
      file = join(root, 'index.html');
      info = await stat(file).catch(() => undefined);
    }
    if (!info?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const immutable = /\.[0-9a-f]{8,}\./.test(file);
    response.writeHead(200, {
      'content-type': type,
      'content-length': String(info.size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(file.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  };

  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    serveStatic(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  };

  const ping = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, PING_MS);
  ping.unref();

  options.server.on('upgrade', onUpgrade);
  options.server.on('request', onRequest);

  return {
    get machines() {
      return new Set(machines.keys());
    },
    close: async () => {
      clearInterval(ping);
      options.server.off('upgrade', onUpgrade);
      options.server.off('request', onRequest);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
  };
}
