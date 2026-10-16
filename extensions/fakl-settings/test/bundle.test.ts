import { existsSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const bundle = join(import.meta.dirname, '..', 'dist', 'extension.js');

/** Um módulo `vscode` falso: qualquer propriedade é uma função que não faz nada. */
function fakeVscode(): unknown {
  const fn = (): undefined => undefined;
  return new Proxy(fn, { get: () => fakeVscode() });
}

describe('dist/extension.js', () => {
  // O build do VS Code empacota a extensão sem node_modules; o pacote precisa
  // carregar sozinho, só com o módulo vscode fornecido pela IDE.
  it.runIf(existsSync(bundle))('carrega sem dependências externas além do vscode', () => {
    const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
    const original = loader._load;
    loader._load = function (request: string, ...rest: unknown[]) {
      return request === 'vscode' ? fakeVscode() : original.call(this, request, ...rest);
    };
    try {
      const extension = createRequire(import.meta.url)(bundle) as Record<string, unknown>;
      expect(typeof extension.activate).toBe('function');
      expect(typeof extension.deactivate).toBe('function');
    } finally {
      loader._load = original;
    }
  });
});
