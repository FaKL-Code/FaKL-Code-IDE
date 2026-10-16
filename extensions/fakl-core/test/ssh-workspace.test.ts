import { describe, expect, it } from 'vitest';

import {
  addRemoteFolder,
  firstLocalFolder,
  normalizeRemotePath,
  planAdd,
  remoteFolders,
  remoteName,
  remoteRoots,
  removeRemoteFolder,
  rootKey,
  SSH_SCHEME,
  type FolderLike,
  type UriLike,
  type WorkspaceLike,
} from '../src/ssh-workspace.js';

const local = (path: string): FolderLike => ({
  uri: { scheme: 'file', authority: '', path },
  name: path,
});
const remote = (alias: string, path: string): FolderLike => ({
  uri: { scheme: SSH_SCHEME, authority: alias, path },
  name: `${alias}:${path}`,
});

/** `vscode.workspace` mínimo: guarda as pastas e aplica o splice de `updateWorkspaceFolders`. */
function fakeWorkspace(initial: FolderLike[]): WorkspaceLike & {
  folders: FolderLike[];
  calls: unknown[][];
} {
  const state = {
    folders: [...initial],
    calls: [] as unknown[][],
    get workspaceFolders(): readonly FolderLike[] | undefined {
      return state.folders.length > 0 ? state.folders : undefined;
    },
    updateWorkspaceFolders(
      start: number,
      deleteCount: number | undefined | null,
      ...add: { uri: UriLike; name?: string }[]
    ): boolean {
      state.calls.push([start, deleteCount, ...add]);
      if (start < 0 || start > state.folders.length) return false;
      state.folders.splice(
        start,
        deleteCount ?? 0,
        ...add.map((f) => ({ uri: f.uri, ...(f.name ? { name: f.name } : {}) })),
      );
      return true;
    },
  };
  return state;
}

const makeUri = (alias: string, path: string): UriLike => ({
  scheme: SSH_SCHEME,
  authority: alias,
  path,
});

describe('caminhos e nomes', () => {
  it('normaliza barras finais e garante a barra inicial', () => {
    expect(normalizeRemotePath('/srv/app/')).toBe('/srv/app');
    expect(normalizeRemotePath('/srv/app///')).toBe('/srv/app');
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('')).toBe('/');
    expect(normalizeRemotePath('srv')).toBe('/srv');
  });

  it('o nome da raiz é host:caminho e a chave não confunde hosts', () => {
    expect(remoteName('site-prod', '/var/www/')).toBe('site-prod:/var/www');
    expect(rootKey('a', '/x/')).toBe(rootKey('a', '/x'));
    expect(rootKey('a', '/x')).not.toBe(rootKey('b', '/x'));
  });
});

describe('raízes do workspace', () => {
  const folders = [remote('prod', '/var/www'), local('/proj'), remote('db', '/srv/')];

  it('lista as remotas com índice, e entrega host + caminho aos agentes', () => {
    expect(remoteFolders(folders).map((r) => [r.index, r.alias, r.path])).toEqual([
      [0, 'prod', '/var/www'],
      [2, 'db', '/srv'],
    ]);
    expect(remoteRoots(folders)).toEqual([
      { host: 'prod', caminho: '/var/www' },
      { host: 'db', caminho: '/srv' },
    ]);
    expect(remoteRoots(undefined)).toEqual([]);
  });

  it('a pasta local do agente é a primeira file://, não a [0]', () => {
    expect(firstLocalFolder(folders)?.uri.path).toBe('/proj');
    expect(firstLocalFolder([remote('a', '/x')])).toBeUndefined();
    expect(firstLocalFolder(undefined)).toBeUndefined();
  });
});

describe('adicionar ao workspace', () => {
  it('planeja no fim da lista, com o nome host:caminho', () => {
    expect(planAdd([local('/p')], 'prod', '/var/www/')).toEqual({
      kind: 'add',
      index: 1,
      name: 'prod:/var/www',
      mayRestartExtensionHost: true,
    });
    expect(planAdd([local('/p'), local('/q')], 'prod', '/x')).toMatchObject({
      index: 2,
      mayRestartExtensionHost: false,
    });
  });

  it('janela sem pasta: entra como primeira raiz e avisa do possível reinício', () => {
    const ws = fakeWorkspace([]);
    const outcome = addRemoteFolder(ws, makeUri, 'prod', '/var/www');
    expect(outcome).toEqual({ kind: 'added', index: 0, mayRestartExtensionHost: true });
    expect(ws.calls).toEqual([
      [
        0,
        0,
        { uri: { scheme: SSH_SCHEME, authority: 'prod', path: '/var/www' }, name: 'prod:/var/www' },
      ],
    ]);
  });

  it('mesma janela: nunca pede nova janela, só mexe na lista de pastas', () => {
    const ws = fakeWorkspace([local('/proj'), local('/outro')]);
    const outcome = addRemoteFolder(ws, makeUri, 'prod', '/var/www');
    expect(outcome).toEqual({ kind: 'added', index: 2, mayRestartExtensionHost: false });
    expect(ws.folders.map((f) => f.name)).toEqual(['/proj', '/outro', 'prod:/var/www']);
  });

  it('pasta já adicionada (mesmo com barra no fim) não duplica', () => {
    const ws = fakeWorkspace([local('/proj'), remote('prod', '/var/www')]);
    expect(addRemoteFolder(ws, makeUri, 'prod', '/var/www/')).toEqual({ kind: 'exists', index: 1 });
    expect(ws.calls).toEqual([]);
    // Outro host com o mesmo caminho é outra pasta.
    expect(addRemoteFolder(ws, makeUri, 'db', '/var/www').kind).toBe('added');
    expect(ws.folders).toHaveLength(3);
  });

  it('a IDE recusar vira falha, e não exceção', () => {
    const ws = fakeWorkspace([local('/proj')]);
    ws.updateWorkspaceFolders = () => false;
    expect(addRemoteFolder(ws, makeUri, 'prod', '/x')).toEqual({ kind: 'failed' });
  });
});

describe('remover do workspace', () => {
  it('tira só a raiz pedida e devolve false se ela não está lá', () => {
    const ws = fakeWorkspace([remote('prod', '/a'), local('/proj'), remote('prod', '/b')]);
    expect(removeRemoteFolder(ws, 'prod', '/b/')).toBe(true);
    expect(ws.folders.map((f) => f.name)).toEqual(['prod:/a', '/proj']);
    expect(removeRemoteFolder(ws, 'prod', '/b')).toBe(false);
    expect(removeRemoteFolder(ws, 'db', '/a')).toBe(false);
    expect(ws.folders).toHaveLength(2);
  });
});
