import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJson, writeJsonAtomic } from '../src/store.js';

describe('writeJsonAtomic', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('grava o mesmo arquivo várias vezes ao mesmo tempo, na ordem pedida', async () => {
    const file = join(dir, 'run.json');
    await Promise.all(Array.from({ length: 20 }, (_, n) => writeJsonAtomic(file, { n })));
    expect(await readJson(file)).toEqual({ n: 19 });
    expect(await readdir(dir)).toEqual(['run.json']);
  });

  it('não perde a gravação enquanto outro processo lê o arquivo (Windows)', async () => {
    const file = join(dir, 'contas.json');
    await writeJsonAtomic(file, { n: 1 });
    // No Windows, um arquivo aberto faz o rename falhar com EPERM até ser fechado.
    const reader = await open(file, 'r');
    const writing = writeJsonAtomic(file, { n: 2 });
    setTimeout(() => void reader.close(), 100);
    await writing;
    expect(await readJson(file)).toEqual({ n: 2 });
    expect(await readdir(dir)).toEqual(['contas.json']);
  });
});
