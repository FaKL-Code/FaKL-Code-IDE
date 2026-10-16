import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { multiplexArgs, quote, RemoteError, RemoteShell } from '../src/ssh-shell.js';

// O mesmo protocolo do ssh, mas com um `sh` local no lugar do servidor.
const posix = process.platform !== 'win32';

describe.runIf(posix)('RemoteShell', () => {
  let dir: string;
  let shell: RemoteShell;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-ssh-'));
    shell = new RemoteShell({ command: 'sh', args: [], timeoutMs: 5_000 });
  });

  afterEach(async () => {
    shell.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('escreve, lê, lista, renomeia e apaga, com nomes difíceis', async () => {
    const name = join(dir, "it's a file.txt");
    const content = new Uint8Array([0, 1, 2, 255, 10, 13, 36, 39]);
    await shell.write(name, content);
    expect(new Uint8Array(await readFile(name))).toEqual(content);
    expect(await shell.read(name)).toEqual(content);

    await shell.mkdir(join(dir, 'sub'));
    await writeFile(join(dir, '.oculto'), 'x');
    const entries = await shell.list(dir);
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: "it's a file.txt", kind: 'file' },
        { name: 'sub', kind: 'dir' },
        { name: '.oculto', kind: 'file' },
      ]),
    );
    expect(entries).toHaveLength(3);

    const stat = await shell.stat(name);
    expect(stat).toMatchObject({ kind: 'file', size: content.length });
    expect((await shell.stat(join(dir, 'sub'))).kind).toBe('dir');

    await shell.rename(name, join(dir, 'novo $nome.txt'));
    expect(await shell.exists(name)).toBe(false);
    expect(await shell.exists(join(dir, 'novo $nome.txt'))).toBe(true);

    await shell.remove(join(dir, 'sub'), false);
    expect(await shell.exists(join(dir, 'sub'))).toBe(false);
  });

  it('erros viram RemoteError e o shell segue funcionando', async () => {
    await expect(shell.stat(join(dir, 'nao-existe'))).rejects.toBeInstanceOf(RemoteError);
    await expect(shell.list(join(dir, 'nao-existe'))).rejects.toBeInstanceOf(RemoteError);
    expect(await shell.list(dir)).toEqual([]);
    expect(await shell.homeDir()).toBe(process.env.HOME);
  });

  it('pedidos em paralelo saem na ordem, cada um com a sua saída', async () => {
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => shell.run(`printf %s ${quote(`r${String(i)}`)}`)),
    );
    expect(outs).toEqual(Array.from({ length: 20 }, (_, i) => `r${String(i)}`));
  });

  it('arquivo grande ida e volta', async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 7) % 256);
    const path = join(dir, 'grande.bin');
    await shell.write(path, big);
    expect(await shell.read(path)).toEqual(big);
  });

  it('a conexão que cai rejeita o pedido e reconecta no próximo', async () => {
    await expect(shell.run('exit 3')).rejects.toBeInstanceOf(RemoteError);
    expect(await shell.run('printf ok')).toBe('ok');
  });
});

describe.runIf(posix)('RemoteShell: reconexão', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-ssh-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A 1ª e a 3ª conexões funcionam; a 2ª cai assim que recebe o primeiro pedido.
  function flaky(): RemoteShell {
    const counter = join(dir, 'n');
    const script = [
      `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'`,
      'if [ "$n" = 2 ]; then read x; exit 1; fi',
      'exec sh',
    ].join('; ');
    return new RemoteShell({ command: 'sh', args: ['-c', script], timeoutMs: 5_000 });
  }

  it('leitura refaz a conexão que caiu no meio e tenta de novo', async () => {
    const shell = flaky();
    try {
      expect(await shell.exists(dir)).toBe(true);
      await expect(shell.run('kill -9 $$')).rejects.toBeInstanceOf(RemoteError);
      // A conexão nova (2ª) cai no pedido; a leitura reconecta (3ª) e responde.
      expect((await shell.stat(dir)).kind).toBe('dir');
    } finally {
      shell.close();
    }
  });

  it('escrita não é repetida sozinha: o erro aparece e a próxima chamada reconecta', async () => {
    const shell = flaky();
    try {
      await shell.exists(dir);
      await expect(shell.run('kill -9 $$')).rejects.toBeInstanceOf(RemoteError);
      await expect(shell.write(join(dir, 'a.txt'), new Uint8Array([1]))).rejects.toBeInstanceOf(
        RemoteError,
      );
      await shell.write(join(dir, 'a.txt'), new Uint8Array([1]));
      expect(await shell.read(join(dir, 'a.txt'))).toEqual(new Uint8Array([1]));
    } finally {
      shell.close();
    }
  });
});

describe('multiplexArgs', () => {
  it('liga ControlMaster fora do Windows e desliga no Windows', () => {
    expect(multiplexArgs('win32')).toEqual([]);
    const args = multiplexArgs('linux');
    expect(args).toEqual(
      expect.arrayContaining([
        'ControlMaster=auto',
        'ControlPersist=60',
        'ControlPath=/tmp/fakl-ssh-%C',
      ]),
    );
    expect(args.filter((a) => a === '-o')).toHaveLength(3);
  });
});
