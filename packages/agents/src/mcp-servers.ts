import { homedir } from 'node:os';

import type { McpServerRef } from './types.js';

/** Shims `.cmd` do Windows que um spawn sem shell não acha (npx.cmd, pnpm.cmd...). */
const WINDOWS_SHIMS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx']);

function expand(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(
    /\$\{(workspaceFolder|userHome)\}/g,
    (match, name: string) => vars[name] ?? match,
  );
}

function expandRecord(
  record: Readonly<Record<string, string>>,
  vars: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, expand(value, vars)]),
  );
}

/**
 * Deixa os servidores prontos para o diretório do agente: expande
 * `${workspaceFolder}` e `${userHome}` e, no Windows, roda os shims `.cmd`
 * pelo `cmd /c`, como o VS Code e o Claude Code recomendam.
 */
export function prepareMcpServers(
  servers: readonly McpServerRef[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): McpServerRef[] {
  const vars = { workspaceFolder: cwd, userHome: home };
  return servers.map((server) => {
    if (server.type === 'http') {
      return {
        ...server,
        url: expand(server.url, vars),
        headers: expandRecord(server.headers, vars),
      };
    }
    const args = server.args.map((arg) => expand(arg, vars));
    const shim = platform === 'win32' && WINDOWS_SHIMS.has(server.command.toLowerCase());
    return {
      ...server,
      command: shim ? 'cmd' : server.command,
      args: shim ? ['/c', server.command, ...args] : args,
      env: expandRecord(server.env, vars),
    };
  });
}
