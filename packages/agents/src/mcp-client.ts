import type { ChildProcess } from 'node:child_process';

import { l10n } from '@fakl/i18n';
import spawn from 'cross-spawn';

import type { McpStdioServerRef } from './types.js';

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 120_000;

export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface Reply {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

/**
 * Cliente MCP mínimo sobre stdio (JSON por linha): inicia o servidor, lista e
 * chama ferramentas. Serve ao adaptador local, que não tem uma CLI de agente
 * para falar MCP por ele.
 */
export class McpStdioClient {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    readonly server: McpStdioServerRef,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async open(): Promise<void> {
    const child = spawn(this.server.command, [...this.server.args], {
      cwd: this.cwd,
      env: { ...this.env, ...this.server.env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.receive(chunk);
    });
    child.stdin?.on('error', () => undefined);
    const fail = (error: Error): void => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    child.once('error', (error) => {
      fail(new Error(l10n.t('MCP server {0}: {1}', this.server.name, error.message)));
    });
    child.once('exit', () => {
      fail(new Error(l10n.t('MCP server {0} exited', this.server.name)));
    });
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'fakl-code', version: '0.1.0' },
    });
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async tools(): Promise<McpToolInfo[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] };
    return result.tools ?? [];
  }

  /** Chama uma ferramenta e devolve o texto do resultado; `isError` vira texto com "Erro:". */
  async call(name: string, args: unknown): Promise<string> {
    const result = (await this.request('tools/call', { name, arguments: args ?? {} })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
      .join('\n');
    return result.isError ? l10n.t('Error: {0}', text) : text;
  }

  close(): void {
    this.closed = true;
    this.child?.stdin?.end();
    this.child?.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error(l10n.t('MCP server {0} closed', this.server.name)));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(l10n.t('MCP server {0} did not respond to {1}', this.server.name, method)),
        );
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(message: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line) continue;
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        continue;
      }
      if (typeof reply.id !== 'number') continue;
      const pending = this.pending.get(reply.id);
      if (!pending) continue;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.error)
        pending.reject(new Error(reply.error.message ?? l10n.t('error in the MCP server')));
      else pending.resolve(reply.result);
    }
  }
}
