import { describe, expect, it } from 'vitest';

import { RemotePoller, type WatchEvent, type WatchRemote } from '../src/ssh-watch.js';

/** Servidor falso em memória: pastas com nomes e mtimes, arquivos com mtime. */
function fakeServer() {
  const dirs = new Map<string, { mtime: number; names: string[] }>();
  const files = new Map<string, { mtime: number; size: number }>();
  const calls: string[] = [];
  const remote: WatchRemote = {
    stat(path) {
      calls.push(`stat ${path}`);
      const dir = dirs.get(path);
      if (dir) return Promise.resolve({ kind: 'dir', size: 4096, mtime: dir.mtime });
      const file = files.get(path);
      if (file) return Promise.resolve({ kind: 'file', ...file });
      return Promise.reject(new Error(`stat: cannot stat '${path}': No such file or directory`));
    },
    list(path) {
      calls.push(`list ${path}`);
      return Promise.resolve((dirs.get(path)?.names ?? []).map((name) => ({ name })));
    },
  };
  return { dirs, files, calls, remote };
}

describe('RemotePoller', () => {
  it('a primeira rodada só memoriza; depois saem criado e apagado', async () => {
    const server = fakeServer();
    server.dirs.set('/srv', { mtime: 1, names: ['a', 'b'] });
    const events: WatchEvent[][] = [];
    const poller = new RemotePoller(server.remote, (e) => events.push(e));
    poller.add('/srv');
    await poller.tick();
    expect(events).toEqual([]);

    server.dirs.set('/srv', { mtime: 2, names: ['b', 'c'] });
    await poller.tick();
    expect(events).toEqual([
      [
        { type: 'created', path: '/srv/c' },
        { type: 'deleted', path: '/srv/a' },
      ],
    ]);
  });

  it('sem mudança de data, a pasta nem é relida', async () => {
    const server = fakeServer();
    server.dirs.set('/srv', { mtime: 1, names: ['a'] });
    const poller = new RemotePoller(server.remote, () => undefined);
    poller.add('/srv');
    await poller.tick();
    server.calls.length = 0;
    await poller.tick();
    await poller.tick();
    expect(server.calls).toEqual(['stat /srv', 'stat /srv']);
  });

  it('arquivo observado: mudou a data ou o tamanho, sai "changed"; apagado, "deleted"', async () => {
    const server = fakeServer();
    server.files.set('/srv/a.txt', { mtime: 1, size: 3 });
    const events: WatchEvent[][] = [];
    const poller = new RemotePoller(server.remote, (e) => events.push(e));
    poller.add('/srv/a.txt');
    await poller.tick();
    server.files.set('/srv/a.txt', { mtime: 1, size: 9 });
    await poller.tick();
    server.files.delete('/srv/a.txt');
    await poller.tick();
    expect(events).toEqual([
      [{ type: 'changed', path: '/srv/a.txt' }],
      [{ type: 'deleted', path: '/srv/a.txt' }],
    ]);
  });

  it('raiz "/" monta caminhos sem barra dupla', async () => {
    const server = fakeServer();
    server.dirs.set('/', { mtime: 1, names: [] });
    const events: WatchEvent[][] = [];
    const poller = new RemotePoller(server.remote, (e) => events.push(e));
    poller.add('/');
    await poller.tick();
    server.dirs.set('/', { mtime: 2, names: ['x'] });
    await poller.tick();
    expect(events[0]).toEqual([{ type: 'created', path: '/x' }]);
  });

  it('falha de rede não gera evento, e a rodada avisa que falhou', async () => {
    const server = fakeServer();
    server.dirs.set('/srv', { mtime: 1, names: [] });
    const events: WatchEvent[][] = [];
    const remote: WatchRemote = {
      ...server.remote,
      stat: () => Promise.reject(new Error('the SSH connection closed')),
    };
    const poller = new RemotePoller(remote, (e) => events.push(e));
    poller.add('/srv');
    expect(await poller.tick()).toBe(false);
    expect(events).toEqual([]);
  });

  it('quem para de observar sai da lista; repetidos dividem a mesma consulta', async () => {
    const server = fakeServer();
    server.dirs.set('/srv', { mtime: 1, names: [] });
    const poller = new RemotePoller(server.remote, () => undefined);
    const stopA = poller.add('/srv');
    const stopB = poller.add('/srv');
    expect(poller.size).toBe(1);
    await poller.tick();
    expect(server.calls).toEqual(['stat /srv', 'list /srv']);
    stopA();
    stopA();
    expect(poller.size).toBe(1);
    stopB();
    expect(poller.size).toBe(0);
    server.calls.length = 0;
    await poller.tick();
    expect(server.calls).toEqual([]);
  });
});
