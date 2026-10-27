import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { newNotePath, NoteTree, pathInside } from '../src/vault-tree-model.js';

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

describe('newNotePath', () => {
  it('um título solto vai para a Inbox', () => {
    expect(newNotePath('Ideia')).toBe('Inbox/Ideia');
    expect(newNotePath('  Ideia  ')).toBe('Inbox/Ideia');
  });

  it('sem pasta, Pasta/Título é um caminho do vault', () => {
    expect(newNotePath('Projetos/Plano')).toBe('Projetos/Plano');
  });

  it('com pasta, o título fica dentro dela, mesmo com barras', () => {
    expect(newNotePath('Ideia', 'Projetos/FaKL')).toBe('Projetos/FaKL/Ideia');
    expect(newNotePath('Sub/Ideia', 'Projetos/FaKL')).toBe('Projetos/FaKL/Sub/Ideia');
  });

  it('troca por hífen os caracteres que não cabem num nome de nota', () => {
    expect(newNotePath('a:b*c?d#e^f[g]h|i')).toBe('Inbox/a-b-c-d-e-f-g-h-i');
  });
});

describe('pathInside', () => {
  const root = resolve('/vault');

  it('devolve o caminho relativo com barras', () => {
    expect(pathInside(root, join(root, 'Projetos', 'Plano.md'))).toBe('Projetos/Plano.md');
  });

  it('aceita pasta cujo nome começa com dois pontos', () => {
    expect(pathInside(root, join(root, '..arquivo', 'nota.md'))).toBe('..arquivo/nota.md');
  });

  it('recusa o que está fora do vault ou é o próprio vault', () => {
    expect(pathInside(root, join(root, '..', 'outro', 'nota.md'))).toBeUndefined();
    expect(pathInside(root, resolve('/outro/nota.md'))).toBeUndefined();
    expect(pathInside(root, root)).toBeUndefined();
  });
});
