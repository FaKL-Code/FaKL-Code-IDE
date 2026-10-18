import { spawn } from 'node:child_process';

import type { McpProbe } from '@fakl/protocol';

export interface McpProbeLauncher {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpProbeOptions {
  readonly timeoutMs?: number;
  /** Ambiente de base; o do Core, por padrão. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const STDERR_TAIL = 400;

/**
 * Lança o servidor MCP `fakl` como o Core o lança para os agentes, mas com um
 * token fictício e um socket que não existe, e pede `initialize` e
 * `tools/list` por stdio. Nenhuma credencial real é usada: `tools/list` não
 * fala com o Core. Nunca rejeita; o resultado diz o que aconteceu.
 */
export function probeMcp(
  launcher: McpProbeLauncher,
  options: McpProbeOptions = {},
): Promise<McpProbe> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(launcher.command, [...launcher.args], {
      env: {
        ...(options.env ?? process.env),
        ...launcher.env,
        FAKL_CORE_SOCKET: 'fakl-doctor-sem-socket',
        FAKL_AGENT_TOKEN: 'fakl-doctor-token-ficticio',
        FAKL_MCP_TOOLS: 'maestro',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (result: McpProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const tail = (): { stderr?: string } => {
      const text = stderr.trim().slice(-STDERR_TAIL);
      return text ? { stderr: text } : {};
    };

    const timer = setTimeout(() => {
      finish({ ok: false, motivo: 'sem-resposta', ...tail() });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      for (const line of stdout.split('\n')) {
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: { tools?: unknown } };
          if (message.id === 2 && Array.isArray(message.result?.tools)) {
            finish({ ok: true, ferramentas: message.result.tools.length });
          }
        } catch {
          // Linha incompleta ou que não é JSON.
        }
      }
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        motivo: error.code === 'ENOENT' ? 'nao-encontrado' : 'saiu',
        ...tail(),
      });
    });
    child.on('close', (code) => {
      finish({ ok: false, motivo: 'saiu', ...(code === null ? {} : { codigo: code }), ...tail() });
    });
    child.stdin.on('error', () => undefined);
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fakl-doctor', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}
