/**
 * Ponto de entrada do processo do Core. O processo principal da IDE o inicia
 * com `utilityProcess.fork` (SDD 6.1), passando o token por ambiente, e o
 * encerra ao fechar a última janela. Também roda sozinho com Node para
 * desenvolvimento: `FAKL_CORE_TOKEN=... node dist/main.js`. Ao iniciar, grava
 * ~/.fakl/run/core.json com o endereço e o token para extensões e CLI.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { l10n, localeFromEnv, useLocale } from '@fakl/i18n';

import { createCore, createSessionToken } from './core.js';
import { HostBridge, type FromHost, type ToHost } from './host.js';
import { coreInfoPath, removeCoreInfo, writeCoreInfo } from './info.js';
import { coreSocketPath } from './paths.js';

interface ParentPort {
  postMessage(message: ToHost): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

// Até a IDE conectar e dizer o idioma da interface, vale o do sistema.
useLocale(localeFromEnv(process.env));

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

// O processo principal reinicia o Core quando ele cai e avisa por aqui (RNF-06).
const restarted = process.env.FAKL_CORE_RESTARTED === '1';
delete process.env.FAKL_CORE_RESTARTED;

const tokenFromEnv = process.env.FAKL_CORE_TOKEN;
const token = tokenFromEnv ?? createSessionToken();
// O token não deve vazar para processos filhos (agentes, terminais).
delete process.env.FAKL_CORE_TOKEN;

// Apps abertos pelo Finder recebem um PATH mínimo, sem as pastas onde o
// Homebrew e o npm instalam as CLIs dos agentes.
if (process.platform === 'darwin') {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')];
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  process.env.PATH = [...current, ...extra.filter((dir) => !current.includes(dir))].join(delimiter);
}

const socketPath = process.env.FAKL_CORE_SOCKET ?? coreSocketPath(process.platform, homedir());
const log = (message: string): void => {
  console.error(`[fakl-core] ${message}`);
};
// O servidor MCP fakl dos maestros: dist/mcp.mjs ao lado do core.mjs empacotado,
// ou mcp/main.js no build do pacote. Roda no mesmo executável; no Electron,
// ELECTRON_RUN_AS_NODE o faz agir como Node.
const mcpScript = [
  fileURLToPath(new URL('./mcp.mjs', import.meta.url)),
  fileURLToPath(new URL('./mcp/main.js', import.meta.url)),
].find((path) => existsSync(path));
const core = createCore({
  socketPath,
  token,
  log,
  configHome: homedir(),
  resumeInterrupted: restarted,
  ...(parentPort ? { host: parentPort } : {}),
  env: process.env,
  ...(mcpScript
    ? {
        mcp: { command: process.execPath, args: [mcpScript], env: { ELECTRON_RUN_AS_NODE: '1' } },
      }
    : {}),
});
const infoPath = coreInfoPath(homedir());
const host = parentPort ? new HostBridge(parentPort, core.bus, core.agents) : undefined;

let stopping = false;
async function shutdown(code = 0): Promise<never> {
  if (!stopping) {
    stopping = true;
    log(l10n.t('shutting down'));
    host?.dispose();
    await core.stop().catch((error: unknown) => {
      log(String(error));
    });
    await removeCoreInfo(infoPath, process.pid).catch(() => undefined);
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
parentPort?.on('message', ({ data }) => {
  const message = data as FromHost | undefined;
  if (message?.type === 'shutdown') void shutdown();
  else if (message) host?.handle(message);
});

try {
  await core.start();
  await writeCoreInfo(infoPath, { socketPath, token, pid: process.pid });
  log(l10n.t('listening on {0}', socketPath));
  parentPort?.postMessage({ type: 'ready', socketPath });
  if (tokenFromEnv === undefined && !parentPort) {
    // Execução manual: mostra o token gerado para conectar a CLI.
    log(l10n.t('session token: {0}', token));
  }
} catch (error) {
  log(l10n.t('failed to start: {0}', String(error)));
  await shutdown(1);
}
