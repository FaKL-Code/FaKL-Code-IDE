import { l10n } from '@fakl/i18n';
import { JsonRpcErrorCode, type CoreMethod } from '@fakl/protocol';

import { LineDecoder } from '../rpc/framing.js';
import { describeParameters, prepareArguments } from './arguments.js';
import type { McpTool } from './tools.js';

/** Versões do MCP que este servidor fala; responde com a pedida, se conhecida. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpTool[];
  /** Chama o Core; um erro vira resultado com `isError`. */
  readonly call: (method: CoreMethod, args: unknown) => Promise<unknown>;
  readonly write: (line: string) => void;
}

interface Message {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Servidor MCP mínimo sobre stdio (JSON por linha), sem dependências. Só o
 * necessário para expor ferramentas: initialize, tools/list, tools/call e
 * ping.
 */
export class McpServer {
  private readonly decoder = new LineDecoder();

  constructor(private readonly options: McpServerOptions) {}

  /** Recebe um pedaço do stdin. */
  push(chunk: string): void {
    for (const line of this.decoder.push(chunk)) void this.handle(line);
  }

  private reply(id: Message['id'], result: unknown): void {
    this.options.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private fail(id: Message['id'], code: number, message: string): void {
    this.options.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  async handle(line: string): Promise<void> {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      this.fail(null, -32700, l10n.t('Invalid JSON'));
      return;
    }
    const { id, method } = message;
    // Notificações (initialized, cancelled) não têm resposta.
    if (id === undefined || id === null || !method) return;
    switch (method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        const version =
          typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSIONS[0];
        this.reply(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: this.options.name, version: this.options.version },
        });
        return;
      }
      case 'ping':
        this.reply(id, {});
        return;
      case 'tools/list':
        this.reply(id, {
          tools: this.options.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
        return;
      case 'tools/call': {
        const name = message.params?.name;
        const tool = this.options.tools.find((candidate) => candidate.name === name);
        if (!tool) {
          this.fail(id, -32602, l10n.t('Unknown tool: {0}', String(name)));
          return;
        }
        const prepared = prepareArguments(tool, message.params?.arguments);
        if (!prepared.ok) {
          this.reply(id, { content: [{ type: 'text', text: prepared.message }], isError: true });
          return;
        }
        try {
          const result = await this.options.call(tool.method, prepared.args);
          this.reply(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: { resultado: result },
          });
        } catch (error) {
          let text = error instanceof Error ? error.message : String(error);
          // Argumento errado: a lista de parâmetros deixa o modelo acertar na próxima.
          if (isInvalidParams(error)) text = `${text}. ${describeParameters(tool)}`;
          this.reply(id, { content: [{ type: 'text', text }], isError: true });
        }
        return;
      }
      default:
        this.fail(id, -32601, l10n.t('Unknown method: {0}', method));
    }
  }
}

function isInvalidParams(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === JsonRpcErrorCode.InvalidParams
  );
}
