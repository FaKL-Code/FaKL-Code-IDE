import { JsonRpcErrorCode } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  describeParameters,
  McpServer,
  prepareArguments,
  SSH_TOOLS,
  type McpTool,
} from '../src/index.js';

function sshTool(name: string): McpTool {
  const tool = SSH_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`sem a ferramenta ${name}`);
  return tool;
}

const sshExec = sshTool('ssh_exec');
const sshWrite = sshTool('ssh_write');

interface CallResult {
  readonly id: number;
  readonly result: { content: { text: string }[]; isError?: boolean };
}

function server(call: (method: string, args: unknown) => Promise<unknown>) {
  const out: CallResult[] = [];
  const mcp = new McpServer({
    name: 'fakl',
    version: '0',
    tools: SSH_TOOLS,
    call,
    write: (line) => out.push(JSON.parse(line) as CallResult),
  });
  const callTool = async (name: string, args: unknown): Promise<CallResult> => {
    await mcp.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: out.length + 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    );
    const last = out.at(-1);
    if (!last) throw new Error('sem resposta');
    return last;
  };
  return { callTool };
}

describe('argumentos das ferramentas MCP', () => {
  it('aceita os nomes em inglês da chamada sem schema (ferramenta deferida)', () => {
    // A primeira chamada do agente, tal como saiu no transcript do Claude Code.
    expect(
      prepareArguments(sshExec, { host: '203.0.113.10', command: 'uptime; df -h', cwd: '/root' }),
    ).toEqual({
      ok: true,
      args: { host: '203.0.113.10', comando: 'uptime; df -h', cwd: '/root' },
    });
    expect(
      prepareArguments(sshWrite, {
        host: 'vps-1',
        path: '/etc/app.conf',
        content: 'x=1',
        createDirs: true,
      }),
    ).toEqual({
      ok: true,
      args: { host: 'vps-1', caminho: '/etc/app.conf', conteudo: 'x=1', criarPastas: true },
    });
  });

  it('não troca um nome que o schema já tem nem sobrescreve o argumento certo', () => {
    expect(prepareArguments(sshExec, { host: 'h', comando: 'ls', command: 'rm -rf /' })).toEqual({
      ok: true,
      args: { host: 'h', comando: 'ls', command: 'rm -rf /' },
    });
  });

  it('recusa sem os obrigatórios e diz quais são os parâmetros', () => {
    const prepared = prepareArguments(sshExec, { host: 'h', script: 'uptime' });
    expect(prepared.ok).toBe(false);
    const message = prepared.ok ? '' : prepared.message;
    expect(message).toContain('faltam argumentos obrigatórios: comando');
    expect(message).toContain('Argumentos desconhecidos: script');
    expect(message).toContain('comando (texto, obrigatório)');
    expect(prepareArguments(sshExec, 'uptime')).toMatchObject({ ok: false });
  });

  it('descreve os parâmetros de uma ferramenta', () => {
    expect(describeParameters(sshExec)).toBe(
      'Parâmetros de ssh_exec: host (texto, obrigatório); comando (texto, obrigatório); cwd (texto); timeoutSeg (número).',
    );
  });
});

describe('servidor MCP: chamadas com argumentos errados', () => {
  it('a primeira chamada de ssh_exec com `command` chega ao Core como `comando`', async () => {
    const calls: unknown[] = [];
    const { callTool } = server((method, args) => {
      calls.push({ method, args });
      return Promise.resolve({ codigo: 0 });
    });
    const reply = await callTool('ssh_exec', { host: '203.0.113.10', command: 'uptime; df -h' });
    expect(reply.result.isError).toBeUndefined();
    expect(calls).toEqual([
      { method: 'ssh.exec', args: { host: '203.0.113.10', comando: 'uptime; df -h' } },
    ]);
  });

  it('sem o obrigatório, nem chama o Core e devolve os parâmetros', async () => {
    const calls: unknown[] = [];
    const { callTool } = server((method, args) => {
      calls.push({ method, args });
      return Promise.resolve({});
    });
    const reply = await callTool('ssh_exec', { host: 'h' });
    expect(calls).toEqual([]);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toContain('Parâmetros de ssh_exec');
  });

  it('erro de parâmetro do Core volta com a lista de parâmetros', async () => {
    const { callTool } = server(() =>
      Promise.reject(
        Object.assign(new Error('cwd inválido'), { code: JsonRpcErrorCode.InvalidParams }),
      ),
    );
    const reply = await callTool('ssh_exec', { host: 'h', comando: 'ls', cwd: '../x' });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]?.text).toBe(`cwd inválido. ${describeParameters(sshExec)}`);
    const other = server(() => Promise.reject(new Error('o usuário negou esta ação')));
    const denied = await other.callTool('ssh_exec', { host: 'h', comando: 'ls' });
    expect(denied.result.content[0]?.text).toBe('o usuário negou esta ação');
  });
});
