import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { coreSocketPath } from '../src/index.js';

describe('coreSocketPath', () => {
  it('usa socket em ~/.fakl/run no macOS', () => {
    expect(coreSocketPath('darwin', '/Users/j', 'j')).toBe(
      join('/Users/j', '.fakl', 'run', 'core.sock'),
    );
  });

  it('usa named pipe por usuário no Windows, sem caracteres inválidos', () => {
    expect(coreSocketPath('win32', 'C:\\Users\\j', 'Ana Silva')).toBe(
      '\\\\.\\pipe\\fakl-core-Ana_Silva',
    );
  });
});
