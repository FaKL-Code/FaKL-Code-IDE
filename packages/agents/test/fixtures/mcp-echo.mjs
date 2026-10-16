// Servidor MCP mínimo para os testes do cliente: uma ferramenta `eco`.
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize')
    reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} } });
  else if (message.method === 'tools/list')
    reply(message.id, {
      tools: [
        {
          name: 'eco',
          description: 'Repete o texto',
          inputSchema: { type: 'object', properties: { texto: { type: 'string' } } },
        },
      ],
    });
  else if (message.method === 'tools/call')
    reply(message.id, {
      content: [{ type: 'text', text: `eco: ${message.params.arguments.texto}` }],
    });
});
