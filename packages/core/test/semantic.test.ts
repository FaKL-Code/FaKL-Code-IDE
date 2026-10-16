import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  chunkNote,
  fold,
  parseConfig,
  SemanticIndex,
  VaultIndex,
  type EmbedFetch,
} from '../src/index.js';

// Um "modelo" de brinquedo: cada dimensão é um tema, contado por palavras-chave.
const THEMES = [
  ['deploy', 'servidor', 'vps', 'publicar'],
  ['gato', 'cachorro', 'bicho'],
  ['bolo', 'receita', 'farinha'],
];

function embedText(text: string): number[] {
  const words = fold(text).split(/\W+/);
  return THEMES.map((theme) => words.filter((w) => theme.includes(w)).length + 0.01);
}

function fakeFetch(calls: string[][], fail = false): EmbedFetch {
  return (url, init) => {
    const body = JSON.parse(init.body) as { model: string; input: string[] };
    calls.push(body.input);
    if (fail) return Promise.reject(new Error('ECONNREFUSED'));
    expect(url).toBe('http://127.0.0.1:11434/v1/embeddings');
    expect(body.model).toBe('nomic-embed-text');
    const data = body.input.map((input, index) => ({ index, embedding: embedText(input) }));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [...data].reverse() }),
      text: () => Promise.resolve(''),
    });
  };
}

async function note(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const config = { provedor: 'ollama', modelo: 'nomic-embed-text' } as const;

describe('busca semântica', () => {
  let root: string;
  let data: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-sem-'));
    data = await mkdtemp(join(tmpdir(), 'fakl-sem-data-'));
    await note(root, 'Projetos/Infra.md', '# Infra\n\nComo publicar no servidor da VPS.');
    await note(root, 'Diário/Pets.md', '# Pets\n\nO gato brigou com o cachorro.');
    await note(root, 'Receitas.md', '# Receitas\n\nBolo de farinha.');
    await note(root, 'Segredo.md', '---\nprivado: true\n---\n# Segredo\n\nsenha do servidor');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });

  it('corta notas em trechos com o título', () => {
    const long = `${'a'.repeat(900)}\n\n${'b'.repeat(600)}\n\n${'c'.repeat(100)}`;
    const chunks = chunkNote('T', long);
    expect(chunks).toEqual([
      `T\n${'a'.repeat(800)}`,
      `T\n${'a'.repeat(100)}\n${'b'.repeat(600)}`,
      `T\n${'c'.repeat(100)}`,
    ]);
    expect(chunkNote('Vazia', '')).toEqual(['Vazia']);
  });

  it('acha pelo sentido, nunca envia notas privadas e só recalcula o que mudou', async () => {
    const index = new VaultIndex(root);
    await index.build();
    const calls: string[][] = [];
    const file = join(data, 'embeddings.json');
    const semantic = new SemanticIndex({ config, file, fetch: fakeFetch(calls) });
    await semantic.start(index);
    await semantic.idle();
    expect(semantic.status()).toMatchObject({ indexadas: 3, pendentes: 0 });
    expect(calls.flat().some((t) => t.includes('senha'))).toBe(false);

    const hits = await semantic.search('onde fazer deploy?', 2);
    expect(hits[0]?.path).toBe('Projetos/Infra.md');
    expect(hits.some((h) => h.path === 'Segredo.md')).toBe(false);
    const pets = await semantic.search('bicho de estimação', 1);
    expect(pets[0]?.path).toBe('Diário/Pets.md');
    semantic.dispose();

    // Reabrindo: os vetores vêm do arquivo; só a nota alterada vai ao modelo.
    // A gravação é assíncrona e no Windows pode passar de 50 ms.
    const saved = await vi.waitFor(
      async () => JSON.parse(await readFile(file, 'utf8')) as unknown,
      {
        timeout: 5000,
        interval: 50,
      },
    );
    expect(saved).toMatchObject({ modelo: 'nomic-embed-text' });
    await note(root, 'Receitas.md', '# Receitas\n\nBolo de cenoura com receita da vó.');
    await index.build();
    const again: string[][] = [];
    const reopened = new SemanticIndex({ config, file, fetch: fakeFetch(again) });
    await reopened.start(index);
    await reopened.idle();
    expect(again.flat()).toEqual([expect.stringContaining('cenoura')]);
    reopened.dispose();
  });

  it('mostra o erro quando o servidor local não responde e tenta de novo depois', async () => {
    const index = new VaultIndex(root);
    await index.build();
    const semantic = new SemanticIndex({ config, fetch: fakeFetch([], true) });
    await semantic.start(index);
    await semantic.idle();
    expect(semantic.status().erro).toContain('não respondeu');
    expect(semantic.status().pendentes).toBe(3);
    semantic.dispose();
  });

  it('valida vault.semantica no config.yaml', () => {
    const vault = (semantica: unknown): unknown => ({ vault: { caminho: 'v', semantica } });
    const ok = parseConfig(vault({ provedor: 'lmstudio', modelo: 'e5' }), 'c');
    expect(ok.vault?.semantica).toEqual({ provedor: 'lmstudio', modelo: 'e5' });
    expect(parseConfig(vault({ modelo: 'e5' }), 'c').vault?.semantica?.provedor).toBe('ollama');
    expect(() => parseConfig(vault({ provedor: 'x', modelo: 'e5' }), 'c')).toThrow(/provedor/);
    expect(() => parseConfig(vault({}), 'c')).toThrow(/modelo/);
    expect(() => parseConfig(vault({ modelo: 'e5', endpoint: 'ftp://x' }), 'c')).toThrow(/http/);
  });
});
