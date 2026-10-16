import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { missingExtensions, readInstalledExtensions } from '../src/index.js';
import { put, tempDir } from './helpers.js';

describe('extensions', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(() => dir.cleanup());

  it('lê o extensions.json do VS Code', async () => {
    await put(
      join(dir.path, 'extensions.json'),
      JSON.stringify([
        { identifier: { id: 'Esbenp.Prettier-VSCode' }, version: '1.0.0' },
        { identifier: { id: 'dbaeumer.vscode-eslint' } },
        { identifier: {} },
      ]),
    );
    expect(await readInstalledExtensions(dir.path)).toEqual([
      'dbaeumer.vscode-eslint',
      'esbenp.prettier-vscode',
    ]);
  });

  it('cai para os nomes das pastas quando não há manifesto', async () => {
    await put(join(dir.path, 'ms-python.python-2024.1.0', 'package.json'), '{}');
    await put(join(dir.path, 'golang.go-0.40.0-universal', 'package.json'), '{}');
    await put(join(dir.path, '.obsolete'), '{}');
    expect(await readInstalledExtensions(dir.path)).toEqual(['golang.go', 'ms-python.python']);
  });

  it('devolve lista vazia sem pasta de extensões', async () => {
    expect(await readInstalledExtensions(join(dir.path, 'nada'))).toEqual([]);
  });

  it('calcula o que falta instalar', () => {
    expect(missingExtensions(['A.b', 'c.d'], ['a.b', 'e.f', 'E.F', 'c.d'])).toEqual(['e.f']);
  });
});
