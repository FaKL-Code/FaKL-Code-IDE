/**
 * Relay do controle remoto em produção. Variáveis:
 * - PORT: porta HTTP (padrão 8080); o TLS fica com o proxy na frente (Caddy).
 * - FAKL_RELAY_STATIC: pasta do PWA (padrão ./public).
 * - FAKL_RELAY_DATA: onde guardar as chaves VAPID (padrão ./data).
 * - FAKL_RELAY_KEY: chave que o Core precisa apresentar (recomendado).
 * - VAPID_SUBJECT: contato do dono, como mailto:voce@exemplo.com.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

import webpush from 'web-push';
import { l10n, localeFromEnv, useLocale } from '@fakl/i18n';

import { createRelay } from './relay.js';

useLocale(localeFromEnv(process.env));

interface Vapid {
  publicKey: string;
  privateKey: string;
}

async function vapidKeys(dir: string): Promise<Vapid> {
  const file = join(dir, 'vapid.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Vapid;
  } catch {
    const keys = webpush.generateVAPIDKeys();
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(keys), { mode: 0o600 });
    return keys;
  }
}

const port = Number(process.env.PORT ?? 8080);
const dataDir = resolve(process.env.FAKL_RELAY_DATA ?? 'data');
const staticDir = resolve(process.env.FAKL_RELAY_STATIC ?? 'public');
const accessKey = process.env.FAKL_RELAY_KEY;
const vapid = await vapidKeys(dataDir);
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT ?? 'mailto:relay@fakl-code.local',
  vapid.publicKey,
  vapid.privateKey,
);

const server = createServer();
const relay = createRelay({
  server,
  staticDir,
  vapidPublicKey: vapid.publicKey,
  ...(accessKey ? { accessKey } : {}),
  push: async (sub, message) => {
    const result = await webpush.sendNotification(sub, JSON.stringify(message), {
      TTL: 3600,
      urgency: 'high',
      ...(message.tag ? { topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    });
    return result.statusCode;
  },
  log: (message) => {
    process.stdout.write(`${new Date().toISOString()} ${message}\n`);
  },
});

server.listen(port, () => {
  process.stdout.write(
    `${l10n.t('FaKL relay on port {0}, PWA at {1}', String(port), staticDir)}\n`,
  );
  if (!accessKey)
    process.stdout.write(
      `${l10n.t('warning: FAKL_RELAY_KEY is not set; any Core can use this relay')}\n`,
    );
});

const stop = (): void => {
  void relay.close().finally(() => {
    server.close(() => process.exit(0));
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
