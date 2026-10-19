/**
 * Servidor MCP `fakl` (SDD 9.1 e 10.4). O agente o inicia por stdio com
 * FAKL_CORE_SOCKET e FAKL_AGENT_TOKEN, um token que só vale para as
 * ferramentas daquela sessão (FAKL_MCP_TOOLS). Cada ferramenta vira um pedido ao
 * Core, que aplica as regras.
 */
import { l10n, localeFromEnv, useLocale } from '@fakl/i18n';

import { isModoEconomia } from '../economia/compactar.js';
import { CoreClient } from '../rpc/client.js';
import { McpServer } from './server.js';
import { TOOL_SETS, type ToolSetName } from './tools.js';

// Responde aos agentes no idioma da IDE, que o Core passa em FAKL_LOCALE.
useLocale(localeFromEnv(process.env));

const socket = process.env.FAKL_CORE_SOCKET;
const token = process.env.FAKL_AGENT_TOKEN;
delete process.env.FAKL_AGENT_TOKEN;
// Quais ferramentas expor: maestro, vault ou as duas (FAKL_MCP_TOOLS=maestro,vault).
const tools = (process.env.FAKL_MCP_TOOLS ?? 'maestro')
  .split(',')
  .flatMap((name) => (name in TOOL_SETS ? TOOL_SETS[name as ToolSetName] : []));

if (!socket || !token) {
  process.stderr.write(
    `${l10n.t('fakl-mcp: FAKL_CORE_SOCKET and FAKL_AGENT_TOKEN are missing')}\n`,
  );
  process.exit(2);
}

let client: Promise<CoreClient> | undefined;
const core = (): Promise<CoreClient> => {
  client ??= CoreClient.connect(socket, token, 'agent').catch((error: unknown) => {
    client = undefined;
    throw error;
  });
  return client;
};

const server = new McpServer({
  name: 'fakl',
  version: '0.1.0',
  tools,
  call: async (method, args) => (await core()).request(method, args),
  write: (line) => process.stdout.write(line),
  // O modo vale desde que a sessão começou (ADR 0052); sem a variável, nada muda.
  modo: () => (isModoEconomia(process.env.FAKL_ECONOMIA) ? process.env.FAKL_ECONOMIA : 'desligado'),
  registrar: (somas) => {
    void core()
      .then((c) => c.request('economia.registrar', somas))
      .catch(() => undefined);
  },
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  server.push(chunk);
});
process.stdin.on('end', () => process.exit(0));
