import { useLocale } from '@fakl/i18n';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clampScale,
  describeGraph,
  describeNode,
  MAX_SCALE,
  MIN_SCALE,
  moveFocus,
  sortNodes,
  stepInList,
  zoomStep,
  type NavNode,
} from '../src/webview/graph-model.js';

function node(path: string, x: number, y: number, title = path): NavNode {
  return { path, title, x, y };
}

beforeEach(() => {
  useLocale('en');
});

describe('zoom', () => {
  it('um passo aproxima ou afasta e respeita os limites', () => {
    expect(zoomStep(1, 'in')).toBeGreaterThan(1);
    expect(zoomStep(1, 'out')).toBeLessThan(1);
    expect(zoomStep(MAX_SCALE, 'in')).toBe(MAX_SCALE);
    expect(zoomStep(MIN_SCALE, 'out')).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
  });
});

describe('lista ordenada', () => {
  const sorted = sortNodes([
    node('z.md', 0, 0, 'Zebra'),
    node('a/b.md', 0, 0, 'ábaco'),
    node('c.md', 0, 0, 'Casa'),
    node('b.md', 0, 0, 'casa'),
  ]);

  it('ordena por título sem diferenciar caixa nem acento, e o caminho desempata', () => {
    expect(sorted.map((n) => n.path)).toEqual(['a/b.md', 'b.md', 'c.md', 'z.md']);
  });

  it('anda para frente e para trás sem dar a volta', () => {
    expect(stepInList(sorted, 'b.md', 1)?.path).toBe('c.md');
    expect(stepInList(sorted, 'b.md', -1)?.path).toBe('a/b.md');
    expect(stepInList(sorted, 'z.md', 1)?.path).toBe('z.md');
    expect(stepInList(sorted, 'a/b.md', -1)?.path).toBe('a/b.md');
  });

  it('sem foco, entra pela primeira ou pela última', () => {
    expect(stepInList(sorted, undefined, 1)?.path).toBe('a/b.md');
    expect(stepInList(sorted, undefined, -1)?.path).toBe('z.md');
    expect(stepInList(sorted, 'sumiu.md', 1)?.path).toBe('a/b.md');
    const empty: NavNode[] = [];
    expect(stepInList(empty, undefined, 1)).toBeUndefined();
  });
});

describe('moveFocus', () => {
  const center = node('c', 0, 0);
  const all = [
    center,
    node('right', 100, 0),
    node('far-right', 300, 0),
    node('left', -80, 0),
    node('up', 0, -60),
    node('down', 10, 90),
    node('diag', 70, 70),
  ];

  it('vai à nota mais próxima na direção da seta', () => {
    expect(moveFocus(center, all, 'right')?.path).toBe('right');
    expect(moveFocus(center, all, 'left')?.path).toBe('left');
    expect(moveFocus(center, all, 'up')?.path).toBe('up');
    expect(moveFocus(center, all, 'down')?.path).toBe('down');
  });

  it('não se escolhe a si mesmo e devolve nada quando não há nota na direção', () => {
    expect(moveFocus(node('edge', 500, 0), all, 'right')).toBeUndefined();
    expect(moveFocus(center, [center], 'right')).toBeUndefined();
  });

  it('ignora notas fora do cone de 60 graus', () => {
    const only = [center, node('steep', 10, 100)];
    expect(moveFocus(center, only, 'right')).toBeUndefined();
    expect(moveFocus(center, only, 'down')?.path).toBe('steep');
  });

  it('notas ligadas ganham desconto na distância', () => {
    const near = node('near', 60, 0);
    const linked = node('linked', 100, 0);
    const list = [center, near, linked];
    expect(moveFocus(center, list, 'right')?.path).toBe('near');
    expect(moveFocus(center, list, 'right', new Set(['linked']))?.path).toBe('linked');
  });

  it('notas no mesmo ponto continuam alcançáveis', () => {
    const twin = node('twin', 0, 0);
    expect(moveFocus(center, [center, twin], 'right')?.path).toBe('twin');
    expect(moveFocus(center, [center, twin], 'left')).toBeUndefined();
  });

  it('desempata pelo caminho, de forma estável', () => {
    const list = [center, node('b', 50, 0), node('a', 50, 0)];
    expect(moveFocus(center, list, 'right')?.path).toBe('a');
  });
});

describe('anúncios', () => {
  it('lê título, pasta e links', () => {
    expect(describeNode({ title: 'Plan', folder: 'work', links: ['Budget', 'Goals'] })).toBe(
      'Plan. folder work. 2 links: Budget, Goals',
    );
    expect(describeNode({ title: 'Plan', folder: '', links: ['Budget'] })).toBe(
      'Plan. 1 link: Budget',
    );
    expect(describeNode({ title: 'Lonely', folder: '', links: [] })).toBe('Lonely. no links');
  });

  it('nomeia só os primeiros links', () => {
    const links = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(describeNode({ title: 'Hub', folder: '', links })).toBe(
      'Hub. 7 links: a, b, c, d, e, and 2 more',
    );
  });

  it('descreve o grafo com os totais', () => {
    expect(describeGraph(12, 1)).toBe('Graph of vault notes, 12 notes, 1 link');
    expect(describeGraph(1, 0)).toBe('Graph of vault notes, 1 note, 0 links');
  });
});
