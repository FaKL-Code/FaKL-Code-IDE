import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { probeMcp } from '../src/mcp/probe.js';

// Servidores falsos: nenhum fala com o Core, nenhum recebe credencial real.
const OK = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    const message = JSON.parse(line);
    if (message.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n');
    if (message.id === 2) {
      const seen = [process.env.FAKL_CORE_SOCKET, process.env.FAKL_AGENT_TOKEN, process.env.FAKL_MCP_TOOLS];
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }, { name: 'b' }], seen } }) + '\\n');
    }
  }
});
`;
const MISSING_ENV = `
process.stderr.write('fakl-mcp: faltam variaveis\\n');
process.exit(2);
`;
const HANG = `setInterval(() => undefined, 1000);`;

describe('probeMcp', () => {
  let dir: string;
  const launch = async (name: string, source: string) => {
    const file = join(dir, name);
    await writeFile(file, source);
    return { command: process.execPath, args: [file] };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-mcp-probe-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('servidor que responde: ok, com as ferramentas listadas', async () => {
    expect(await probeMcp(await launch('ok.js', OK), { env: process.env })).toEqual({
      ok: true,
      ferramentas: 2,
    });
  });

  it('comando que não existe: não encontrado', async () => {
    const result = await probeMcp({ command: join(dir, 'nao-existe'), args: [] });
    expect(result).toMatchObject({ ok: false, motivo: 'nao-encontrado' });
  });

  it('saída com código e as últimas linhas do stderr', async () => {
    const result = await probeMcp(await launch('falha.js', MISSING_ENV));
    expect(result).toMatchObject({ ok: false, motivo: 'saiu', codigo: 2 });
    expect(result.stderr).toContain('faltam variaveis');
  });

  it('servidor que não responde dentro do tempo', async () => {
    const result = await probeMcp(await launch('trava.js', HANG), { timeoutMs: 400 });
    expect(result).toMatchObject({ ok: false, motivo: 'sem-resposta' });
  });
});
