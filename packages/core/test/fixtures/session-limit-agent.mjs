import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../../agents/package.json', import.meta.url));
const acp = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);
let turns = 0;
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
acp
  .agent({ name: 'session-limit-test' })
  .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest('session/new', () => ({ sessionId: 'original' }))
  .onRequest('session/prompt', async (ctx) => {
    turns++;
    if (turns === 1 && process.argv[2] === 'error') {
      throw new acp.RequestError(-32603, 'Internal error', {
        details: 'Rate limit exceeded. Retry after 60 seconds',
      });
    }
    const text =
      turns === 1
        ? "You've hit your limit · resets 5pm (America/Sao_Paulo)"
        : `continuado: ${turns}`;
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    return { stopReason: 'end_turn' };
  })
  .connect(stream);
