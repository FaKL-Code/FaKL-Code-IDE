import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fold, SemanticIndex, VaultIndex, type EmbedFetch } from '../src/index.js';

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

function fakeFetch(calls: string[][]): EmbedFetch {
  return (_url, init) => {
    const body = JSON.parse(init.body) as { input: string[] };
    calls.push(body.input);
    const data = body.input.map((input, index) => ({ index, embedding: embedText(input) }));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data }),
      text: () => Promise.resolve(''),
    });
  };
}

async function note(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

const config = { provedor: 'ollama', modelo: 'nomic-embed-text' } as const;

describe('busca semântica: caches', () => {
  let root: string;
  let data: string;
  let calls: string[][];
  let poupado: { itens: number; caracteres: number }[];
  let index: VaultIndex;
  let semantic: SemanticIndex;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-semc-'));
    data = await mkdtemp(join(tmpdir(), 'fakl-semc-data-'));
    await note(root, 'Infra.md', '# Infra\n\nComo publicar no servidor da VPS.');
    await note(root, 'Receitas.md', '# Receitas\n\nBolo de farinha.');
    calls = [];
    poupado = [];
    index = new VaultIndex(root);
    await index.build();
    semantic = new SemanticIndex({
      config,
      file: join(data, 'embeddings.json'),
      fetch: fakeFetch(calls),
      economizou: (p) => poupado.push(p),
    });
    await semantic.start(index);
    await semantic.idle();
    calls.length = 0;
  });

  afterEach(async () => {
    semantic.dispose();
    // No Windows o arquivo de embeddings pode ser gravado no instante da limpeza.
    const limpar = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
    await rm(root, limpar);
    await rm(data, limpar);
  });

  /** O índice do vault relê o disco e o índice semântico confere o que mudou. */
  async function reread(): Promise<void> {
    await index.build();
    semantic.reconcile();
    await semantic.idle();
  }

  it('a mesma pergunta não é embutida duas vezes, mesmo com espaços a mais', async () => {
    const first = await semantic.search('onde fazer deploy?', 1);
    expect(calls).toEqual([['onde fazer deploy?']]);
    expect(poupado).toEqual([]);

    const again = await semantic.search('  onde   fazer deploy? ', 1);
    expect(calls).toHaveLength(1);
    expect(again[0]?.path).toBe(first[0]?.path);
    expect(poupado).toEqual([{ itens: 1, caracteres: 'onde fazer deploy?'.length }]);

    await semantic.search('bicho de estimação', 1);
    expect(calls).toHaveLength(2);
  });

  it('a nota movida de pasta não é embutida de novo', async () => {
    await mkdir(join(root, 'Cozinha'), { recursive: true });
    await rename(join(root, 'Receitas.md'), join(root, 'Cozinha', 'Receitas.md'));
    await reread();

    expect(calls).toEqual([]);
    expect(poupado.reduce((sum, p) => sum + p.itens, 0)).toBeGreaterThan(0);
    const hits = await semantic.search('receita de bolo', 1);
    expect(hits[0]?.path).toBe('Cozinha/Receitas.md');
  });

  it('editar um trecho e desfazer não volta à API', async () => {
    const original = '# Receitas\n\nBolo de farinha.';
    await note(root, 'Receitas.md', '# Receitas\n\nBolo de cenoura com cobertura.');
    await reread();
    expect(calls).toHaveLength(1);

    calls.length = 0;
    await note(root, 'Receitas.md', original);
    await reread();
    expect(calls).toEqual([]);
  });

  it('nota que virou privada não fica na reserva: ao voltar a ser pública é embutida de novo', async () => {
    await note(root, 'Receitas.md', '---\nprivado: true\n---\n# Receitas\n\nBolo de farinha.');
    await reread();
    expect(calls).toEqual([]);

    await note(root, 'Receitas.md', '# Receitas\n\nBolo de farinha.');
    await reread();
    expect(calls).toHaveLength(1);
  });

  it('a reserva vai para o arquivo só com o hash do trecho, nunca com o texto', async () => {
    await mkdir(join(root, 'Cozinha'), { recursive: true });
    await rename(join(root, 'Receitas.md'), join(root, 'Cozinha', 'Receitas.md'));
    await reread();
    semantic.dispose();

    const file = join(data, 'embeddings.json');
    const saved = await vi.waitFor(
      async () => {
        const stored = JSON.parse(await readFile(file, 'utf8')) as {
          reserva?: Record<string, string>;
        };
        if (!stored.reserva) throw new Error('ainda sem reserva');
        return stored;
      },
      { timeout: 5000, interval: 50 },
    );
    const keys = Object.keys(saved.reserva ?? {});
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => /^[0-9a-f]{40}$/.test(key))).toBe(true);
    expect(JSON.stringify(saved.reserva)).not.toContain('farinha');
  });
});
