import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { endpointHost, fold, parseConfig, SemanticIndex, VaultIndex } from '../src/index.js';
import { SECRET_NAMES } from '../src/secrets.js';

const KEY = 'segredo-segredo-segredo';
const THEMES = [
  ['deploy', 'servidor', 'vps', 'publicar'],
  ['gato', 'cachorro', 'bicho'],
  ['bolo', 'receita', 'farinha'],
];

function embedText(text: string): number[] {
  const words = fold(text).split(/\W+/);
  return THEMES.map((theme) => words.filter((w) => theme.includes(w)).length + 0.01);
}

interface Seen {
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: { model: string; input: string[] };
}

type Handler = (
  seen: Seen,
  count: number,
) => { status: number; headers?: Record<string, string>; body: string } | undefined;

/** Servidor HTTP falso em 127.0.0.1: fala `POST /v1/embeddings` e não sai da máquina. */
async function fakeApi(
  handler: Handler = () => undefined,
): Promise<{ server: Server; endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Seen['body'];
      const call: Seen = { url: req.url ?? '', headers: req.headers, body };
      seen.push(call);
      const custom = handler(call, seen.length);
      if (custom) {
        res.writeHead(custom.status, { 'content-type': 'application/json', ...custom.headers });
        res.end(custom.body);
        return;
      }
      const data = body.input.map((input, index) => ({ index, embedding: embedText(input) }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${String(port)}/v1`, seen };
}

async function note(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

describe('busca semântica por API compatível com a da OpenAI', () => {
  let root: string;
  let data: string;
  let api: Awaited<ReturnType<typeof fakeApi>> | undefined;
  const logs: string[] = [];
  const sleep = vi.fn(() => Promise.resolve());

  beforeEach(async () => {
    logs.length = 0;
    sleep.mockClear();
    root = await mkdtemp(join(tmpdir(), 'fakl-api-'));
    data = await mkdtemp(join(tmpdir(), 'fakl-api-data-'));
    await note(root, 'Projetos/Infra.md', '# Infra\n\nComo publicar no servidor da VPS.');
    await note(root, 'Diário/Pets.md', '# Pets\n\nO gato brigou com o cachorro.');
    await note(root, 'Segredo.md', '---\nprivado: true\n---\n# Segredo\n\nsenha do servidor');
  });

  afterEach(async () => {
    const closing = api?.server;
    await new Promise<void>((resolve) => {
      if (closing)
        closing.close(() => {
          resolve();
        });
      else resolve();
    });
    api = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });

  async function open(
    endpoint: string,
    over: { modelo?: string; confirmar?: boolean; key?: string | undefined; file?: string } = {},
  ): Promise<SemanticIndex> {
    const index = new VaultIndex(root);
    await index.build();
    const semantic = new SemanticIndex({
      config: {
        provedor: 'openai',
        modelo: over.modelo ?? 'text-embedding-3-small',
        endpoint,
        ...(over.confirmar === false ? {} : { confirmadoPara: endpointHost(endpoint) }),
      },
      ...(over.file ? { file: over.file } : {}),
      apiKey: () => ('key' in over ? over.key : KEY),
      sleep,
      log: (message) => logs.push(message),
    });
    await semantic.start(index);
    await semantic.idle();
    return semantic;
  }

  it('indexa e busca com a chave no cabeçalho, sem enviar notas privadas', async () => {
    api = await fakeApi();
    const semantic = await open(api.endpoint);
    expect(api.seen[0]?.url).toBe('/v1/embeddings');
    expect(api.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(api.seen[0]?.headers['api-key']).toBe(KEY);
    expect(api.seen[0]?.body.model).toBe('text-embedding-3-small');
    expect(api.seen.flatMap((s) => s.body.input).some((t) => t.includes('senha'))).toBe(false);
    expect(semantic.status()).toMatchObject({
      indexadas: 2,
      pendentes: 0,
      remota: true,
      servidor: endpointHost(api.endpoint),
      chave: true,
    });
    const hits = await semantic.search('onde fazer deploy?', 1);
    expect(hits[0]?.path).toBe('Projetos/Infra.md');
    semantic.dispose();
  });

  it('não envia nada sem a confirmação do servidor e estima o custo', async () => {
    api = await fakeApi();
    const semantic = await open(api.endpoint, { confirmar: false });
    expect(api.seen).toHaveLength(0);
    const status = semantic.status();
    expect(status).toMatchObject({ aguardaConfirmacao: true, indexadas: 0, pendentes: 2 });
    expect(status.estimativa?.notas).toBe(2);
    expect(status.estimativa?.trechos).toBe(2);
    expect(status.estimativa?.tokens).toBeGreaterThan(10);
    await expect(semantic.search('deploy')).rejects.toThrow(/confirmado/);
    expect(api.seen).toHaveLength(0);
    semantic.dispose();
  });

  it('a confirmação vale só para o servidor confirmado', async () => {
    api = await fakeApi();
    const index = new VaultIndex(root);
    await index.build();
    const semantic = new SemanticIndex({
      config: {
        provedor: 'openai',
        modelo: 'm',
        endpoint: api.endpoint,
        confirmadoPara: 'outro-servidor.example.com',
      },
      apiKey: () => KEY,
    });
    await semantic.start(index);
    await semantic.idle();
    expect(api.seen).toHaveLength(0);
    expect(semantic.status().aguardaConfirmacao).toBe(true);
    semantic.dispose();
  });

  it('recusa da chave (401) vira erro claro, sem a chave, e a fila espera', async () => {
    api = await fakeApi(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }),
    }));
    const semantic = await open(api.endpoint);
    const { erro } = semantic.status();
    expect(erro).toContain('recusou a chave');
    expect(erro).toContain('401');
    expect(`${erro ?? ''}${logs.join('\n')}`).not.toContain(KEY);
    expect(semantic.status().pendentes).toBe(2);
    semantic.dispose();
  });

  it('a chave nunca aparece em erro ou log, nem quando o servidor a repete', async () => {
    api = await fakeApi(() => ({ status: 500, body: `falha interna para ${KEY}` }));
    const semantic = await open(api.endpoint);
    const { erro } = semantic.status();
    expect(erro).toContain('HTTP 500');
    expect(erro).toContain('***');
    expect(`${erro ?? ''}${logs.join('\n')}`).not.toContain(KEY);
    semantic.dispose();
  });

  it('sem chave guardada não faz pedido nenhum', async () => {
    api = await fakeApi();
    const semantic = await open(api.endpoint, { key: undefined });
    expect(api.seen).toHaveLength(0);
    expect(semantic.status()).toMatchObject({ chave: false });
    expect(semantic.status().erro).toContain('chave');
    semantic.dispose();
  });

  it('429 espera (Retry-After ou recuo exponencial) e tenta de novo', async () => {
    api = await fakeApi((_seen, count) =>
      count === 1
        ? { status: 429, headers: { 'retry-after': '2' }, body: '{}' }
        : count === 2
          ? { status: 429, body: '{}' }
          : undefined,
    );
    const semantic = await open(api.endpoint);
    expect(sleep.mock.calls.map((c) => (c as unknown as number[])[0])).toEqual([2000, 2000]);
    expect(semantic.status()).toMatchObject({ indexadas: 2, pendentes: 0 });
    expect(semantic.status().erro).toBeUndefined();
    semantic.dispose();
  });

  it('429 sem fim para depois das tentativas e mostra o limite de taxa', async () => {
    api = await fakeApi(() => ({ status: 429, body: '{}' }));
    const semantic = await open(api.endpoint);
    expect(api.seen).toHaveLength(5);
    expect(semantic.status().erro).toContain('429');
    expect(semantic.status().pendentes).toBe(2);
    semantic.dispose();
  });

  it('resposta malformada vira erro e não grava vetor', async () => {
    api = await fakeApi(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ embedding: 'nao-e-lista' }] }),
    }));
    const semantic = await open(api.endpoint);
    expect(semantic.status().indexadas).toBe(0);
    expect(semantic.status().erro).toBeDefined();
    semantic.dispose();

    api.server.close();
    api = await fakeApi(() => ({ status: 200, body: 'isso nao e json' }));
    const again = await open(api.endpoint);
    expect(again.status().indexadas).toBe(0);
    expect(again.status().erro).toBeDefined();
    again.dispose();
  });

  it('dimensões diferentes dentro de uma resposta são malformadas', async () => {
    api = await fakeApi((seen) => ({
      status: 200,
      body: JSON.stringify({
        data: seen.body.input.map((_t, index) => ({
          index,
          embedding: index === 0 ? [1, 2, 3] : [1, 2],
        })),
      }),
    }));
    await note(
      root,
      'Projetos/Outra.md',
      '# Outra\n\n' + 'x'.repeat(900) + '\n\n' + 'y'.repeat(900),
    );
    const semantic = await open(api.endpoint);
    expect(semantic.status().erro).toContain('malformada');
    semantic.dispose();
  });

  it('trocar de modelo (ou de provedor) descarta os vetores do índice anterior', async () => {
    api = await fakeApi();
    const file = join(data, 'embeddings.json');
    const first = await open(api.endpoint, { file });
    expect(first.status().indexadas).toBe(2);
    first.dispose();
    await vi.waitFor(
      async () => {
        expect(JSON.parse(await readFile(file, 'utf8'))).toBeDefined();
      },
      {
        timeout: 5000,
        interval: 50,
      },
    );
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      provedor: 'openai',
      modelo: 'text-embedding-3-small',
    });

    // Mesmo modelo: usa o arquivo, sem novos pedidos.
    const before = api.seen.length;
    const same = await open(api.endpoint, { file });
    expect(api.seen.length).toBe(before);
    expect(same.status().indexadas).toBe(2);
    same.dispose();

    // Outro modelo: tudo recalculado, e com o modelo novo.
    const other = await open(api.endpoint, { file, modelo: 'text-embedding-3-large' });
    const models = new Set(api.seen.slice(before).map((s) => s.body.model));
    expect([...models]).toEqual(['text-embedding-3-large']);
    expect(api.seen.length).toBeGreaterThan(before);
    expect(other.status().indexadas).toBe(2);
    other.dispose();
  });

  it('cache por conteúdo: trecho igual ao já calculado não vai de novo à API', async () => {
    api = await fakeApi();
    const long = `${'a'.repeat(700)}

${'b'.repeat(700)}`;
    await note(
      root,
      'Projetos/Longa.md',
      `# Longa

${long}`,
    );
    const index = new VaultIndex(root);
    await index.build();
    const semantic = new SemanticIndex({
      config: {
        provedor: 'openai',
        modelo: 'm',
        endpoint: api.endpoint,
        confirmadoPara: endpointHost(api.endpoint),
      },
      apiKey: () => KEY,
    });
    await semantic.start(index);
    await semantic.idle();
    const before = api.seen.flatMap((s) => s.body.input).length;
    expect(semantic.status().indexadas).toBe(3);
    // Outra nota com exatamente o mesmo texto e título: nada novo a enviar.
    await note(
      root,
      'Projetos/Copia.md',
      `# Longa

${long}`,
    );
    await index.build();
    semantic.reconcile();
    await semantic.idle();
    expect(semantic.status().indexadas).toBe(4);
    expect(api.seen.flatMap((s) => s.body.input)).toHaveLength(before);
    semantic.dispose();
  });

  it('valida a configuração: openai exige endpoint e guarda a confirmação', () => {
    const vault = (semantica: unknown): unknown => ({ vault: { caminho: 'v', semantica } });
    expect(() => parseConfig(vault({ provedor: 'openai', modelo: 'm' }), 'c')).toThrow(/endpoint/);
    const ok = parseConfig(
      vault({
        provedor: 'openai',
        modelo: 'm',
        endpoint: 'https://api.openai.com/v1',
        confirmadoPara: 'api.openai.com',
      }),
      'c',
    );
    expect(ok.vault?.semantica).toEqual({
      provedor: 'openai',
      modelo: 'm',
      endpoint: 'https://api.openai.com/v1',
      confirmadoPara: 'api.openai.com',
    });
    // Confirmação não vale para provedor local.
    expect(parseConfig(vault({ modelo: 'm', confirmadoPara: 'x' }), 'c').vault?.semantica).toEqual({
      provedor: 'ollama',
      modelo: 'm',
    });
  });

  it('a chave de embeddings é um segredo próprio, fora de apikey.<provedor>', () => {
    expect(SECRET_NAMES).toContain('vault.embeddings');
    expect(endpointHost('https://api.openai.com/v1')).toBe('api.openai.com');
    expect(endpointHost('http://127.0.0.1:8080/v1')).toBe('127.0.0.1:8080');
    expect(endpointHost('lixo')).toBe('');
  });
});
