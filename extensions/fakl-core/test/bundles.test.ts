import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const dist = (name: string): string => fileURLToPath(new URL(`../dist/${name}`, import.meta.url));

// Os bundles ESM com dependência CommonJS morriam ao iniciar com "Dynamic require of
// "fs" is not supported" quando faltava o banner do createRequire no esbuild: o servidor
// MCP `fakl` e a CLI nunca subiam nas releases. O CI roda `pnpm build` antes dos testes.
const built = existsSync(dist('mcp.mjs')) && existsSync(dist('fakl.mjs'));

describe.skipIf(!built)('bundles ESM compilados', () => {
  it('o servidor MCP sobe e responde ao initialize', () => {
    const result = spawnSync(process.execPath, [dist('mcp.mjs')], {
      input: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      })}\n`,
      env: {
        ...process.env,
        FAKL_CORE_SOCKET: String.raw`\.\pipe\inexistente`,
        FAKL_AGENT_TOKEN: 'teste',
        FAKL_MCP_TOOLS: 'maestro',
      },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.stderr).not.toContain('Dynamic require');
    const reply = JSON.parse(result.stdout.split('\n')[0] ?? '{}') as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(reply.result?.serverInfo?.name).toBe('fakl');
  });

  it('a CLI fakl mostra a ajuda', () => {
    const result = spawnSync(process.execPath, [dist('fakl.mjs'), '--help'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.stderr).not.toContain('Dynamic require');
    expect(result.stdout).toContain('fakl');
    expect(result.status).toBe(0);
  });
});
