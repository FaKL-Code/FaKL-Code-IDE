// Agente ACP falso para os testes do adaptador. O comportamento sai do texto
// da mensagem (e FAKE_LOAD, FAKE_RESUME e FAKE_LOAD_FAIL ligam a retomada de sessão): "olá", "permissão", "escreva <arquivo>", "fora", "lento",
// "segredo", "limite", "sair".
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

const sessions = new Map();

const say = (cx, sessionId, text) =>
  cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('cancelado'));
    });
  });

let authFailures = 0;
/** Método de login pedido pelo cliente (`authenticate`); a chave vem de FAKE_API_KEY. */
let authenticated;

async function prompt(params, cx) {
  const { sessionId } = params;
  const controller = new AbortController();
  sessions.set(sessionId, controller);
  const text = params.prompt.map((block) => block.text).join('\n');
  const last = params.prompt.at(-1).text;
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

  if (last === 'olá') {
    await say(cx, sessionId, `oi (${params.prompt.length} blocos)`);
  } else if (last === 'permissão') {
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Editar a.txt',
        kind: 'edit',
        status: 'pending',
        rawInput: { file_path: 'a.txt', content: 'oi', replace_all: false },
      },
    });
    const answer = await cx.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId: 't1',
        title: 'Editar a.txt',
        kind: 'edit',
        rawInput: { file_path: 'a.txt', content: 'oi', replace_all: false },
      },
      options: [
        { optionId: 'sim', name: 'Permitir', kind: 'allow_once' },
        { optionId: 'sempre', name: 'Permitir sempre', kind: 'allow_always' },
        { optionId: 'nao', name: 'Negar', kind: 'reject_once' },
      ],
    });
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
    });
    const outcome = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelado';
    await say(cx, sessionId, `resposta: ${outcome}`);
  } else if (last.startsWith('escreva ')) {
    const path = last.slice('escreva '.length);
    await cx.request(acp.methods.client.fs.writeTextFile, {
      sessionId,
      path,
      content: 'um\ndois\ntrês',
    });
    const read = await cx.request(acp.methods.client.fs.readTextFile, {
      sessionId,
      path,
      line: 2,
      limit: 1,
    });
    await say(cx, sessionId, `li: ${read.content}`);
  } else if (last.startsWith('demora ')) {
    // Fica um tempo vivo antes de escrever, para dois agentes coexistirem.
    const path = last.slice('demora '.length);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await cx.request(acp.methods.client.fs.writeTextFile, {
      sessionId,
      path,
      content: `feito por ${process.pid}`,
    });
    await say(cx, sessionId, `escrevi ${path}`);
  } else if (last === 'fora') {
    await cx.request(acp.methods.client.fs.writeTextFile, {
      sessionId,
      path: '../fora.txt',
      content: 'x',
    });
  } else if (last === 'lento') {
    try {
      await sleep(10_000, controller.signal);
    } catch {
      return { stopReason: 'cancelled' };
    }
  } else if (last === 'limite') {
    // Como o Claude Code ao bater a sessão de 5 h: o prompt falha com o aviso.
    throw new Error(
      'Claude AI usage limit reached. Your limit will reset at 7pm.\nDetalhes do plano.',
    );
  } else if (last === 'login disputado') {
    authFailures += 1;
    if (authFailures === 1) throw new Error('Failed to refresh OAuth token');
    await say(cx, sessionId, `entrou na tentativa ${authFailures}`);
  } else if (last === 'sem uso') {
    // Como o codex-acp: só usage_update com o contexto, nada de usage na resposta.
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'usage_update', used: 1200, size: 200000 },
    });
    await say(cx, sessionId, 'doze caracteres');
    return { stopReason: 'end_turn' };
  } else if (last === 'com cache') {
    // Como o claude-agent-acp: a entrada nova é mínima e o resto vem do cache.
    await say(cx, sessionId, 'ok');
    return {
      stopReason: 'end_turn',
      usage: {
        inputTokens: 12,
        outputTokens: 4248,
        totalTokens: 234805,
        cachedReadTokens: 201340,
        cachedWriteTokens: 29205,
      },
    };
  } else if (last === 'girar') {
    // Um agente preso: chama a mesma ferramenta sem parar, até a rodada ser cancelada.
    for (let i = 0; i < 200 && !controller.signal.aborted; i++) {
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: `g${i}`,
          title: 'Ler docs.md',
          kind: 'read',
          status: 'in_progress',
        },
      });
      await sleep(20, controller.signal).catch(() => undefined);
    }
    return { stopReason: 'cancelled' };
  } else if (last === 'segredo') {
    await say(cx, sessionId, process.env.FAKL_TEST_SECRET ?? 'sem segredo');
  } else if (last === 'sair') {
    process.stderr.write('falha simulada\n');
    process.exit(3);
  } else {
    await say(cx, sessionId, `eco: ${text}`);
  }
  return { stopReason: 'end_turn', usage };
}

let model = 'rapido';
const configOptions = () => [
  {
    id: 'model',
    name: 'Modelo',
    category: 'model',
    type: 'select',
    currentValue: model,
    options: [
      { group: 'leves', name: 'Leves', options: [{ value: 'rapido', name: 'Rápido' }] },
      { group: 'fortes', name: 'Fortes', options: [{ value: 'forte', name: 'Forte' }] },
    ],
  },
  { id: 'web', name: 'Busca na web', type: 'boolean', currentValue: false },
];

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
acp
  .agent({ name: 'fake-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      ...(process.env.FAKE_LOAD === '1' ? { loadSession: true } : {}),
      ...(process.env.FAKE_RESUME === '1' ? { sessionCapabilities: { resume: {} } } : {}),
    },
    authMethods: [
      { id: 'fake-login', name: 'Login' },
      { id: 'fake-api-key', name: 'Chave de API' },
    ],
  }))
  .onRequest('authenticate', (ctx) => {
    if (ctx.params.methodId === 'fake-api-key' && !process.env.FAKE_API_KEY) {
      throw new acp.RequestError(-32000, 'sem chave');
    }
    authenticated = ctx.params.methodId;
    return {};
  })
  // Retomar: o agente reenvia a conversa antiga ("ANTIGA") e responde com as opções.
  .onRequest('session/load', async (ctx) => {
    if (process.env.FAKE_LOAD_FAIL === '1')
      throw new acp.RequestError(-32602, 'sessão desconhecida');
    await say(ctx.client, ctx.params.sessionId, 'ANTIGA');
    return { configOptions: configOptions() };
  })
  .onRequest('session/resume', () => ({ configOptions: configOptions() }))
  .onRequest('session/new', async () => {
    if (process.env.FAKE_HANG === '1') await new Promise(() => undefined);
    if (process.env.FAKE_AUTH === '1' && !authenticated)
      throw new acp.RequestError(-32000, 'Authentication required');
    return { sessionId: `s${sessions.size + 1}`, configOptions: configOptions() };
  })
  .onRequest('session/set_config_option', (ctx) => {
    if (ctx.params.configId === 'model') model = ctx.params.value;
    return { configOptions: configOptions() };
  })
  .onRequest('session/prompt', (ctx) => prompt(ctx.params, ctx.client))
  .onNotification('session/cancel', (ctx) => {
    sessions.get(ctx.params.sessionId)?.abort();
  })
  .connect(stream);
