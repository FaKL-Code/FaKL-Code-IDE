import { describe, expect, it } from 'vitest';

import { NoteTree } from '../src/vault-tree-model.js';

const PATHS = [
  'Inbox/Ideia.md',
  'Projetos/FaKL/Plano.md',
  'Projetos/FaKL/Notas 10.md',
  'Projetos/FaKL/Notas 2.md',
  'Projetos/Resumo.md',
  'Diário/2026-10-27.md',
  'Leia-me.md',
  'Agentes/Sessões/Execução.md',
];

describe('NoteTree', () => {
  const tree = new NoteTree(PATHS);

  it('na raiz, as pastas vêm antes das notas, cada grupo em ordem alfabética', () => {
    expect(tree.children().map((node) => `${node.kind}:${node.path}`)).toEqual([
      'folder:Agentes',
      'folder:Diário',
      'folder:Inbox',
      'folder:Projetos',
      'note:Leia-me.md',
    ]);
  });

  it('cada pasta conta as notas de dentro, subpastas incluídas', () => {
    const folders = Object.fromEntries(
      tree.children().flatMap((node) => (node.kind === 'folder' ? [[node.name, node.count]] : [])),
    );
    expect(folders).toEqual({ Agentes: 1, Diário: 1, Inbox: 1, Projetos: 4 });
    expect(tree.size).toBe(PATHS.length);
  });

  it('o nome da nota é o do arquivo sem .md, e números ordenam como números', () => {
    expect(tree.children('Projetos/FaKL').map((node) => node.kind === 'note' && node.name)).toEqual(
      ['Notas 2', 'Notas 10', 'Plano'],
    );
  });

  it('uma pasta só com subpastas as mostra', () => {
    expect(tree.children('Agentes')).toEqual([
      { kind: 'folder', path: 'Agentes/Sessões', name: 'Sessões', count: 1 },
    ]);
  });

  it('acha o pai de uma nota e de uma pasta, e a raiz não tem pai', () => {
    const note = tree.noteNode('Projetos/FaKL/Plano.md');
    expect(tree.parent(note)).toMatchObject({ kind: 'folder', path: 'Projetos/FaKL' });
    const folder = tree.parent(note);
    expect(folder && tree.parent(folder)).toMatchObject({ path: 'Projetos' });
    expect(tree.parent(tree.noteNode('Leia-me.md'))).toBeUndefined();
  });

  it('sabe se uma nota existe', () => {
    expect(tree.has('Inbox/Ideia.md')).toBe(true);
    expect(tree.has('Inbox/Outra.md')).toBe(false);
    expect(tree.has('Inbox')).toBe(false);
  });

  it('um vault vazio não tem filhos', () => {
    const empty = new NoteTree([]);
    expect(empty.children()).toEqual([]);
    expect(empty.size).toBe(0);
  });
});
