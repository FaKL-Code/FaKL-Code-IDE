import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentEnv, findExecutable } from '../src/index.js';

describe('findExecutable', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-which-'));
    await mkdir(join(dir, 'bin'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('acha executáveis no PATH', async () => {
    const file = join(dir, 'bin', 'agente');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    const env = { PATH: ['/nao/existe', join(dir, 'bin')].join(delimiter) };
    expect(await findExecutable('agente', env, 'linux')).toBe(file);
    expect(await findExecutable('outro', env, 'linux')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('ignora arquivo sem permissão de execução', async () => {
    await writeFile(join(dir, 'bin', 'agente'), '');
    expect(await findExecutable('agente', { PATH: join(dir, 'bin') }, 'linux')).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')(
    'prefere o .cmd do npm ao script sem extensão',
    async () => {
      await writeFile(join(dir, 'bin', 'agente'), '');
      await writeFile(join(dir, 'bin', 'agente.cmd'), '');
      const found = await findExecutable('agente', {
        Path: join(dir, 'bin'),
        PATHEXT: '.EXE;.CMD',
      });
      expect(found?.toLowerCase()).toBe(join(dir, 'bin', 'agente.cmd').toLowerCase());
    },
  );
});

describe('agentEnv', () => {
  it('passa só as variáveis permitidas, sem diferenciar maiúsculas', () => {
    const env = agentEnv(
      {
        Path: '/bin',
        HOME: '/home/j',
        LC_ALL: 'pt_BR.UTF-8',
        ANTHROPIC_API_KEY: 'segredo',
        GITHUB_TOKEN: 'segredo',
        AWS_SECRET_ACCESS_KEY: 'segredo',
      },
      { FAKL_AGENT_ID: 'a1' },
    );
    expect(env).toEqual({
      Path: '/bin',
      HOME: '/home/j',
      LC_ALL: 'pt_BR.UTF-8',
      FAKL_AGENT_ID: 'a1',
    });
  });
});
