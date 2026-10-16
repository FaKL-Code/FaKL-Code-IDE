import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coreInfoPath, readCoreInfo, removeCoreInfo, writeCoreInfo } from '../src/index.js';

describe('core.json', () => {
  let home: string;
  let path: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-info-'));
    path = coreInfoPath(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('fica em ~/.fakl/run', () => {
    expect(path).toBe(join(home, '.fakl', 'run', 'core.json'));
  });

  it('grava e lê o endereço e o token', async () => {
    const info = { socketPath: '/tmp/core.sock', token: 'abc', pid: 42 };
    await writeCoreInfo(path, info);
    expect(await readCoreInfo(path)).toEqual(info);
  });

  it.skipIf(process.platform === 'win32')('é legível só pelo usuário', async () => {
    await writeCoreInfo(path, { socketPath: 's', token: 't', pid: 1 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('ignora arquivo ausente ou incompleto', async () => {
    expect(await readCoreInfo(path)).toBeUndefined();
    await writeCoreInfo(path, { socketPath: 's', token: 't', pid: 1 });
    await writeFile(path, '{"socketPath":"s"}');
    expect(await readCoreInfo(path)).toBeUndefined();
  });

  it('só remove o arquivo do próprio processo', async () => {
    await writeCoreInfo(path, { socketPath: 's', token: 't', pid: 1 });
    await removeCoreInfo(path, 2);
    expect(await readCoreInfo(path)).toBeDefined();
    await removeCoreInfo(path, 1);
    expect(await readCoreInfo(path)).toBeUndefined();
  });
});
