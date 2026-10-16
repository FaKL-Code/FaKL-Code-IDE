import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  endpointOf,
  LocalAdapter,
  textToolCalls,
  type AgentEvent,
  type AgentProfile,
  type FetchLike,
} from '../src/index.js';

const PROFILE: AgentProfile = {
  id: 'local',
  nome: 'Local',
  provedor: 'ollama',
  adaptador: 'ollama',
  modelo: 'qwen',
};

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Servidor falso: devolve as respostas na ordem e guarda os pedidos de chat. */
function fakeServer(replies: unknown[][], models = ['qwen:latest']) {
  const requests: { messages: { role: string; content?: string }[]; tools?: unknown[] }[] = [];
  const fetcher: FetchLike = (url, init) => {
    if (url.endsWith('/models')) {
      return Promise.resolve(Response.json({ data: models.map((id) => ({ id })) }));
    }
    requests.push(JSON.parse(init?.body as string) as (typeof requests)[number]);
    const next = replies.shift();
    if (!next) return Promise.resolve(new Response('acabou', { status: 500 }));
    return Promise.resolve(sse(next));
  };
  return { fetcher, requests };
}

function toolCall(id: string, name: string) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: '' } }],
        },
      },
    ],
  };
}

function toolArgs(args: unknown) {
  return {
    choices: [
      { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } },
    ],
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fakl-local-'));
  await writeFile(path.join(dir, 'a.txt'), 'olá mundo\n');
});

afterEach(async () => {
  // No Windows, o servidor MCP morto pode segurar a pasta por um instante.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('LocalAdapter', () => {
  it('detecta o servidor e o modelo', async () => {
    expect(endpointOf(PROFILE)).toBe('http://127.0.0.1:11434/v1');
    expect(endpointOf({ ...PROFILE, provedor: 'lmstudio' })).toBe('http://127.0.0.1:1234/v1');
    const ok = new LocalAdapter(PROFILE, { fetch: fakeServer([]).fetcher });
    expect(await ok.detect()).toEqual({ status: 'pronto', path: 'http://127.0.0.1:11434/v1' });
    const missing = new LocalAdapter(PROFILE, { fetch: fakeServer([], ['llama3']).fetcher });
    expect(await missing.detect()).toEqual({
      status: 'não-instalado',
      install: 'ollama pull qwen',
    });
    const down = new LocalAdapter(PROFILE, {
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect((await down.detect()).status).toBe('não-instalado');
  });

  it('roda o laço de ferramentas com raciocínio, edição e uso', async () => {
    const { fetcher, requests } = fakeServer([
      [
        { choices: [{ delta: { content: '<think>vou ler' } }] },
        { choices: [{ delta: { content: '</think>' } }] },
        toolCall('c1', 'read_file'),
        toolArgs({ path: 'a.txt' }),
      ],
      [toolCall('c2', 'edit_file'), toolArgs({ path: 'a.txt', old: 'mundo', new: 'FaKL' })],
      [
        { choices: [{ delta: { content: 'Pronto.' } }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      ],
    ]);
    const handle = await new LocalAdapter(PROFILE, { fetch: fetcher }).start({
      profile: PROFILE,
      cwd: dir,
      permissions: 'aprovar-leitura',
      systemPrompt: 'Seja breve.',
    });
    const events: AgentEvent[] = [];
    handle.onEvent((event) => {
      events.push(event);
      if (event.type === 'permission') void handle.respondPermission(event.id, true);
    });
    await handle.send('troque mundo por FaKL');
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('olá FaKL\n');
    expect(requests[0]?.messages[0]).toMatchObject({ role: 'system' });
    expect(requests[0]?.messages[0]?.content).toContain('Seja breve.');
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', content: 'olá mundo\n' });
    const thoughts = events.filter((e) => e.type === 'output' && e.kind === 'thought');
    expect(thoughts).toEqual([{ type: 'output', kind: 'thought', text: 'vou ler' }]);
    expect(events).toContainEqual({ type: 'output', kind: 'message', text: 'Pronto.' });
    // Leitura passa direto em aprovar-leitura; edição pergunta.
    const asked = events.filter((e) => e.type === 'permission');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ title: 'Editar a.txt' });
    expect(events).toContainEqual({ type: 'file', path: 'a.txt' });
    expect(handle.usage()).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 13,
      cost: { amount: 0, currency: 'USD' },
    });
    expect(handle.state).toBe('ocioso');
    await handle.stop('usuário');
    expect(handle.state).toBe('parado');
  });

  it('nega a ação e não sai do worktree', async () => {
    const { fetcher, requests } = fakeServer([
      [toolCall('c1', 'run_command'), toolArgs({ command: 'echo oi' })],
      [toolCall('c2', 'read_file'), toolArgs({ path: '../fora.txt' })],
      [{ choices: [{ delta: { content: 'ok' } }] }],
    ]);
    const handle = await new LocalAdapter(PROFILE, { fetch: fetcher }).start({
      profile: PROFILE,
      cwd: dir,
      permissions: 'perguntar',
    });
    handle.onEvent((event) => {
      if (event.type === 'permission') void handle.respondPermission(event.id, false);
    });
    await handle.send('rode algo');
    expect(requests[1]?.messages.at(-1)?.content).toContain('negou');
    // A leitura também pergunta em `perguntar`; negada, não chega a sair do worktree.
    expect(requests[2]?.messages.at(-1)?.content).toContain('negou');
    await handle.stop('usuário');
  });

  it('roda comandos com aprovar-tudo', async () => {
    const { fetcher, requests } = fakeServer([
      [toolCall('c1', 'run_command'), toolArgs({ command: 'node -e "console.log(41+1)"' })],
      [toolCall('c2', 'read_file'), toolArgs({ path: '../fora.txt' })],
      [{ choices: [{ delta: { content: 'ok' } }] }],
    ]);
    const handle = await new LocalAdapter(PROFILE, { fetch: fetcher }).start({
      profile: PROFILE,
      cwd: dir,
      permissions: 'aprovar-tudo',
    });
    await handle.send('rode');
    expect(requests[1]?.messages.at(-1)?.content).toContain('42');
    expect(requests[2]?.messages.at(-1)?.content).toContain('fora do worktree');
    await handle.stop('usuário');
  });

  it('aceita chamadas de ferramenta escritas como texto por modelos pequenos', async () => {
    const text = (content: string) => [{ choices: [{ delta: { content } }] }];
    const { fetcher, requests } = fakeServer([
      text('```json\n{"name": "write_file", "arguments": {"path": "b.txt", "content": "ok"}}\n```'),
      text('<tool_call>{"name": "read_file", "parameters": {"path": "b.txt"}}</tool_call>'),
      text('Pronto.'),
    ]);
    const handle = await new LocalAdapter(PROFILE, { fetch: fetcher }).start({
      profile: PROFILE,
      cwd: dir,
      permissions: 'aprovar-tudo',
    });
    await handle.send('crie b.txt');
    expect(await readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('ok');
    expect(requests[2]?.messages.at(-1)).toMatchObject({ role: 'tool', content: 'ok' });
    await handle.stop('usuário');

    const known = new Set(['read_file']);
    expect(textToolCalls('{"name": "outra", "arguments": {}}', known)).toEqual([]);
    expect(textToolCalls('Veja {"name": "read_file"} no meio do texto', known)).toEqual([]);
    expect(
      textToolCalls(
        '[{"function": {"name": "read_file", "arguments": "{\\"path\\":\\"a\\"}"}}]',
        known,
      ),
    ).toEqual([
      {
        id: 'text_0',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a"}' },
      },
    ]);
  });

  it('troca o modelo local com a sessão viva', async () => {
    const { fetcher, requests } = fakeServer(
      [[{ choices: [{ delta: { content: 'ok' } }] }]],
      ['qwen:latest', 'llama3:latest'],
    );
    const handle = await new LocalAdapter(PROFILE, { fetch: fetcher }).start({
      profile: PROFILE,
      cwd: dir,
      permissions: 'perguntar',
    });
    expect(handle.sessionOptions()[0]).toMatchObject({ id: 'model', atual: 'qwen:latest' });
    await handle.setOption('model', 'llama3:latest');
    await handle.send('oi');
    expect((requests[0] as unknown as { model: string }).model).toBe('llama3:latest');
    await expect(handle.setOption('model', 'gpt')).rejects.toThrow(/inválida/);
    await handle.stop('usuário');
  });

  it('falha ao iniciar sem o modelo', async () => {
    await expect(
      new LocalAdapter(PROFILE, { fetch: fakeServer([], ['outro']).fetcher }).start({
        profile: PROFILE,
        cwd: dir,
        permissions: 'perguntar',
      }),
    ).rejects.toThrow(/qwen/);
  });
});

describe('ferramentas MCP no adaptador local', () => {
  it('lista e chama as ferramentas dos servidores da sessão', async () => {
    const { fetcher, requests } = fakeServer([
      [toolCall('c1', 'fakl__eco'), toolArgs({ texto: 'oi' })],
      [{ choices: [{ delta: { content: 'ok' } }] }],
    ]);
    const handle = await new LocalAdapter(PROFILE, { fetch: fetcher }).start({
      profile: PROFILE,
      cwd: dir,
      permissions: 'perguntar',
      mcpServers: [
        {
          name: 'fakl',
          command: process.execPath,
          args: [path.join(import.meta.dirname, 'fixtures', 'mcp-echo.mjs')],
          env: {},
        },
      ],
    });
    await handle.send('chame o eco');
    const names = (requests[0]?.tools ?? []).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(names).toContain('fakl__eco');
    // O servidor do Core aplica a própria política, então não pergunta aqui.
    expect(requests[1]?.messages.at(-1)?.content).toBe('eco: oi');
    await handle.stop('usuário');
  });
});
