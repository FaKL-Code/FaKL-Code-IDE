// Maestro ACP falso: abre o servidor MCP `fakl` que recebeu no session/new e
// segue um roteiro de ferramentas. FAKE_MAESTRO define o roteiro:
// "completo" (padrão), "falha", "parado" (termina a vez sem finish),
// "dupla" (delega a dois subagentes em paralelo, cada um num arquivo),
// "rodadas" (roda run_checks até estourar o limite de rodadas) ou
// "recursos" (acha um agente com find_resources e delega com ele, sem profileId).
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

let mcpConfig = [];

const say = (cx, sessionId, text) =>
  cx.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });

function mcpClient(server) {
  const env = { ...process.env };
  for (const { name, value } of server.env) env[name] = value;
  const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return {
    async init() {
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'falso', version: '0' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      return (await request('tools/list', {})).result.tools.map((tool) => tool.name);
    },
    async call(name, args) {
      const response = await request('tools/call', { name, arguments: args });
      const text = response.result?.content?.[0]?.text ?? JSON.stringify(response.error);
      if (response.result?.isError) return { erro: text };
      return JSON.parse(text);
    },
    close: () => child.stdin.end(),
  };
}

/** Sessão do chat (Maestro Mode): "Delegue." chama um subagente e integra o trabalho dele. */
async function delegate(sessionId, cx) {
  const fakl = mcpClient(mcpConfig.find((server) => server.name === 'fakl'));
  const log = { tools: await fakl.init() };
  try {
    const spawned = await fakl.call('spawn_agent', {
      profileId: 'falso',
      papel: 'executor',
      instrucoes: 'escreva novo.txt',
    });
    log.spawned = spawned;
    log.results = await fakl.call('await_results', {
      sessionIds: [spawned.sessionId],
      timeoutSeg: 20,
    });
    log.merge = await fakl.call('merge_work', { sessionIds: [spawned.sessionId] });
  } finally {
    fakl.close();
  }
  await say(cx, sessionId, JSON.stringify(log));
  return { stopReason: 'end_turn' };
}

async function prompt(params, cx) {
  const { sessionId } = params;
  const last = params.prompt.at(-1).text;
  if (last === 'Delegue.') return delegate(sessionId, cx);
  const mode = process.env.FAKE_MAESTRO ?? 'completo';
  if (mode === 'limite-sessao') {
    if (last === 'Comece a tarefa.') {
      await writeFile('limite.txt', 'trabalho antes do limite');
      await say(cx, sessionId, "You've hit your limit · resets in 5 minutes");
      return { stopReason: 'end_turn' };
    }
    const fakl = mcpClient(mcpConfig.find((server) => server.name === 'fakl'));
    try {
      const tools = await fakl.init();
      const profiles = await fakl.call('list_profiles', {});
      const saved = await readFile('limite.txt', 'utf8');
      await say(
        cx,
        sessionId,
        JSON.stringify({
          retomou: true,
          tools,
          profiles,
          saved,
          historico: params.prompt.some((block) => block.text?.includes('Conversa anterior')),
        }),
      );
      await fakl.call('run_checks', {});
      await fakl.call('finish', { veredito: 'sucesso', resumo: 'retomada preservou trabalho' });
    } finally {
      fakl.close();
    }
    return { stopReason: 'end_turn' };
  }
  if (last !== 'Comece a tarefa.' || mode === 'parado') {
    await say(cx, sessionId, 'ok');
    return { stopReason: 'end_turn' };
  }
  const fakl = mcpClient(mcpConfig.find((server) => server.name === 'fakl'));
  const log = { tools: await fakl.init() };
  try {
    log.profiles = await fakl.call('list_profiles', {});
    if (mode === 'falha') {
      log.finish = await fakl.call('finish', { veredito: 'falha', resumo: 'não deu' });
      return { stopReason: 'end_turn' };
    }
    if (mode === 'dupla') {
      const spawned = await Promise.all(
        ['a.txt', 'b.txt'].map((file) =>
          fakl.call('spawn_agent', {
            profileId: 'falso',
            papel: 'executor',
            instrucoes: `demora ${file}`,
          }),
        ),
      );
      log.spawned = spawned;
      const ids = spawned.map((s) => s.sessionId);
      log.results = await fakl.call('await_results', { sessionIds: ids, timeoutSeg: 30 });
      log.merge = await fakl.call('merge_work', { sessionIds: ids });
      log.checks = await fakl.call('run_checks', {});
      await say(cx, sessionId, JSON.stringify(log));
      await fakl.call('finish', { veredito: 'sucesso', resumo: 'a.txt e b.txt criados' });
      return { stopReason: 'end_turn' };
    }
    if (mode === 'recursos') {
      log.found = await fakl.call('find_resources', { tarefa: 'escrever arquivos de texto' });
      log.sugestao = await fakl.call('suggest_profile', { instrucoes: 'corrigir typo no README' });
      log.semPerfil = await fakl.call('spawn_agent', { instrucoes: 'x' });
      log.perfilInvalido = await fakl.call('spawn_agent', {
        profileId: 42,
        agente: 'escritor',
        instrucoes: 'x',
      });
      log.inexistente = await fakl.call('spawn_agent', { agente: 'nenhum', instrucoes: 'x' });
      const spawned = await fakl.call('spawn_agent', {
        agente: log.found[0]?.name,
        instrucoes: 'escreva novo.txt',
      });
      log.spawned = spawned;
      await fakl.call('await_results', { sessionIds: [spawned.sessionId], timeoutSeg: 20 });
      log.merge = await fakl.call('merge_work', { sessionIds: [spawned.sessionId] });
      log.checks = await fakl.call('run_checks', {});
      await say(cx, sessionId, JSON.stringify(log));
      await fakl.call('finish', { veredito: 'sucesso', resumo: 'novo.txt criado' });
      return { stopReason: 'end_turn' };
    }
    if (mode === 'rodadas') {
      log.checks = [];
      for (let i = 0; i < 4; i++) log.checks.push(await fakl.call('run_checks', {}));
      await say(cx, sessionId, JSON.stringify(log));
      await fakl.call('finish', { veredito: 'falha', resumo: 'o critério nunca passou' });
      return { stopReason: 'end_turn' };
    }
    log.proibido = await fakl.call('spawn_agent', {
      profileId: 'falso',
      papel: 'maestro',
      instrucoes: 'x',
    });
    const spawned = await fakl.call('spawn_agent', {
      profileId: 'falso',
      papel: 'executor',
      instrucoes: 'escreva novo.txt',
    });
    log.spawned = spawned;
    log.results = await fakl.call('await_results', {
      sessionIds: [spawned.sessionId],
      timeoutSeg: 20,
    });
    log.diff = await fakl.call('review_diff', { sessionId: spawned.sessionId });
    log.merge = await fakl.call('merge_work', { sessionIds: [spawned.sessionId] });
    log.checks = await fakl.call('run_checks', {});
    // finish encerra este agente; o registro vai antes.
    await say(cx, sessionId, JSON.stringify(log));
    await fakl.call('finish', { veredito: 'sucesso', resumo: 'novo.txt criado' });
  } finally {
    fakl.close();
  }
  return { stopReason: 'end_turn' };
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
acp
  .agent({ name: 'fake-maestro' })
  .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest('session/new', (ctx) => {
    mcpConfig = ctx.params.mcpServers;
    return { sessionId: 'm1' };
  })
  .onRequest('session/prompt', (ctx) => prompt(ctx.params, ctx.client))
  .onNotification('session/cancel', () => undefined)
  .connect(stream);
