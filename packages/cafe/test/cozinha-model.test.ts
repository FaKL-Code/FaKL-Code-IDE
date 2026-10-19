import type { CiRun, CiStatus } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import {
  AnnouncerGroup,
  cellAt,
  CELL_H,
  CELL_W,
  cupFrame,
  describeKitchen,
  describeRun,
  formatSeconds,
  HEADER_H,
  kitchenLayout,
  kitchenRuns,
  KITCHEN_MAX,
  mergeRun,
  pixelClock,
  runSeconds,
  RunAnnouncer,
  stationLook,
} from '../src/index.js';

const NOW = Date.UTC(2026, 9, 18, 13, 0, 0);
const minutes = (n: number): string => new Date(NOW - n * 60_000).toISOString();

function run(
  id: number,
  estado: CiRun['estado'],
  startedMinAgo: number,
  extra: Partial<CiRun> = {},
): CiRun {
  return {
    repo: 'acme/app',
    id,
    numero: id,
    nome: `flow-${String(id)}`,
    branch: 'main',
    evento: 'push',
    estado,
    url: `https://github.com/acme/app/actions/runs/${String(id)}`,
    inicio: minutes(startedMinAgo),
    jobs: [],
    ...extra,
  };
}

function status(...runs: CiRun[]): CiStatus {
  return {
    conectado: true,
    automatico: true,
    repos: [{ repo: 'acme/app', origem: 'marcado', runs }],
    descartados: [],
    falhando: 0,
    trabalhando: 0,
    verdesSeguidos: 0,
  };
}

describe('pose do cozinheiro por estado', () => {
  it('trabalhando alterna dois quadros e o resto tem pose própria', () => {
    expect(stationLook('trabalhando', 0).cook).toBe(1);
    expect(stationLook('trabalhando', 1).cook).toBe(2);
    expect(stationLook('sucesso', 0)).toMatchObject({ cook: 3, prop: 'bell', mood: 'ok' });
    expect(stationLook('falha', 0)).toMatchObject({ cook: 4, prop: 'alarm', mood: 'bad' });
    expect(stationLook('aguardando', 0)).toMatchObject({ cook: 0, prop: 'ticket' });
    expect(stationLook('fila', 0)).toMatchObject({ cook: 0, prop: undefined });
    // Cancelada: bancada vazia, sem cozinheiro.
    expect(stationLook('cancelada', 0).cook).toBeUndefined();
  });

  it('com movimento reduzido nada alterna', () => {
    expect(stationLook('trabalhando', 0, true)).toEqual(stationLook('trabalhando', 1, true));
    expect(cupFrame('trabalhando', 0, true)).toBe(cupFrame('trabalhando', 1, true));
  });

  it('escolhe o quadro da xícara de cada job', () => {
    expect([
      cupFrame('fila'),
      cupFrame('trabalhando'),
      cupFrame('sucesso'),
      cupFrame('falha'),
      cupFrame('cancelada'),
      cupFrame('aguardando'),
    ]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('execuções na bancada', () => {
  it('mostra só a execução mais recente de cada fluxo', () => {
    const list = kitchenRuns(
      [
        run(1, 'falha', 30, { nome: 'build' }),
        run(2, 'sucesso', 10, { nome: 'build' }),
        run(3, 'sucesso', 20, { nome: 'build', branch: 'feat/x' }),
      ],
      NOW,
    );
    expect(list.map((r) => r.id).sort()).toEqual([2, 3]);
  });

  it('põe primeiro o que pede atenção, depois o que roda', () => {
    const list = kitchenRuns(
      [
        run(1, 'sucesso', 5),
        run(2, 'trabalhando', 4),
        run(3, 'falha', 3),
        run(4, 'aguardando', 2),
        run(5, 'cancelada', 1),
        run(6, 'fila', 1),
      ],
      NOW,
    );
    expect(list.map((r) => r.estado)).toEqual([
      'aguardando',
      'falha',
      'trabalhando',
      'fila',
      'sucesso',
      'cancelada',
    ]);
  });

  it('tira as terminadas há muito tempo e corta no máximo', () => {
    const old = run(1, 'sucesso', 60 * 24, { fim: minutes(60 * 24) });
    expect(kitchenRuns([old], NOW)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) =>
      run(i + 1, 'sucesso', i, { nome: `f${String(i)}` }),
    );
    expect(kitchenRuns(many, NOW)).toHaveLength(KITCHEN_MAX);
  });

  it('troca a execução que chegou por evento e acrescenta a nova', () => {
    const base = status(run(1, 'trabalhando', 5), run(2, 'sucesso', 9));
    const next = mergeRun(base, run(1, 'falha', 5));
    expect(next.repos[0]?.runs.map((r) => [r.id, r.estado])).toEqual([
      [1, 'falha'],
      [2, 'sucesso'],
    ]);
    const added = mergeRun(base, run(3, 'fila', 0));
    expect(added.repos[0]?.runs).toHaveLength(3);
    // Repositório que não é acompanhado fica de fora.
    expect(mergeRun(base, run(9, 'fila', 0, { repo: 'acme/other' }))).toEqual(base);
  });
});

describe('duração', () => {
  it('conta até agora enquanto roda e até o fim depois', () => {
    expect(runSeconds(run(1, 'trabalhando', 2), NOW)).toBe(120);
    expect(runSeconds(run(1, 'sucesso', 5, { fim: minutes(3) }), NOW)).toBe(120);
    expect(runSeconds(run(1, 'sucesso', 5), NOW)).toBeUndefined();
  });

  it('escreve a duração por extenso e na fonte de pixel', () => {
    expect(formatSeconds(12)).toBe('12s');
    expect(formatSeconds(65)).toBe('1m 05s');
    expect(formatSeconds(3_780)).toBe('1h 03m');
    expect(formatSeconds(undefined)).toBe('');
    expect(pixelClock(65)).toBe('1:05');
    expect(pixelClock(3_780)).toBe('1H03');
    expect(pixelClock(undefined)).toBe('-:--');
  });
});

describe('texto para leitor de tela', () => {
  it('descreve a execução com estado, duração e jobs', () => {
    const text = describeRun(
      run(1, 'falha', 5, {
        nome: 'build',
        fim: minutes(3),
        jobs: [
          { id: 1, nome: 'lint', estado: 'sucesso' },
          { id: 2, nome: 'test', estado: 'falha' },
        ],
      }),
      NOW,
    );
    expect(text).toBe('build (main), acme/app, failed, 2m 00s, 1 of 2 jobs passed');
  });

  it('resume a cozinha', () => {
    expect(describeKitchen(undefined)).toBe('');
    expect(describeKitchen({ ...status(), falhando: 1, trabalhando: 2, verdesSeguidos: 7 })).toBe(
      'CI kitchen: 1 failing, 2 running, 7 green in a row',
    );
  });
});

describe('anúncio agrupado das execuções', () => {
  it('fixa o ponto de partida e anuncia só resultados', () => {
    const a = new RunAnnouncer({ minIntervalMs: 5_000 });
    a.observe([run(1, 'sucesso', 9), run(2, 'trabalhando', 3)]);
    expect(a.waiting).toBe(false);
    // Entrou na fila e começou: não se anuncia.
    a.observe([run(1, 'sucesso', 9), run(2, 'trabalhando', 3), run(3, 'fila', 0)]);
    expect(a.waiting).toBe(false);
    a.observe([run(1, 'sucesso', 9), run(2, 'falha', 3), run(3, 'trabalhando', 0)]);
    expect(a.waiting).toBe(true);
    expect(a.take(0)).toBe('flow-2 in acme/app: failed');
    expect(a.waiting).toBe(false);
  });

  it('agrupa vários resultados numa frase e põe a espera por você primeiro', () => {
    const a = new RunAnnouncer({ minIntervalMs: 5_000, maxNames: 1 });
    a.observe([]);
    a.observe([
      run(1, 'sucesso', 1),
      run(2, 'sucesso', 1),
      run(3, 'sucesso', 1),
      run(4, 'aguardando', 1),
      run(5, 'falha', 1),
    ]);
    expect(a.take(0)).toBe(
      'flow-4 in acme/app: waiting for approval; flow-5 in acme/app: failed; 3 CI runs passed',
    );
  });

  it('respeita o intervalo e esquece o que voltou ao já dito', () => {
    const a = new RunAnnouncer({ minIntervalMs: 5_000 });
    a.observe([run(1, 'trabalhando', 1)]);
    a.observe([run(1, 'sucesso', 1)]);
    expect(a.take(1_000)).toBe('flow-1 in acme/app: passed');
    a.observe([run(1, 'falha', 1)]);
    expect(a.waitMs(2_000)).toBe(4_000);
    expect(a.take(2_000)).toBeUndefined();
    // Voltou ao que já foi dito antes de falar: some.
    a.observe([run(1, 'sucesso', 1)]);
    expect(a.waiting).toBe(false);
    expect(a.waitMs(9_000)).toBeUndefined();
  });

  it('o grupo junta os agentes e as execuções numa só fala', () => {
    const speaking = { waitMs: () => 3_000, take: () => 'Ana: working' };
    const quiet = { waitMs: () => undefined, take: () => undefined };
    const ci = { waitMs: () => 1_000, take: () => 'flow-1 in acme/app: failed' };
    const group = new AnnouncerGroup(speaking, quiet, ci);
    expect(group.waitMs(0)).toBe(1_000);
    expect(group.take(0)).toBe('Ana: working. flow-1 in acme/app: failed');
    expect(new AnnouncerGroup(quiet).take(0)).toBeUndefined();
    expect(new AnnouncerGroup(quiet).waitMs(0)).toBeUndefined();
  });
});

describe('disposição das bancadas', () => {
  it('usa pelo menos duas colunas e no máximo quatro', () => {
    expect(kitchenLayout(0)).toMatchObject({ columns: 2, rows: 1, width: 2 * CELL_W });
    expect(kitchenLayout(3)).toMatchObject({ columns: 3, rows: 1 });
    expect(kitchenLayout(8)).toMatchObject({ columns: 4, rows: 2, height: HEADER_H + 2 * CELL_H });
  });

  it('acha a bancada sob o clique', () => {
    expect(cellAt(5, 2, 4)).toBeUndefined();
    expect(cellAt(5, HEADER_H + 5, 4)).toBe(0);
    expect(cellAt(CELL_W + 1, HEADER_H + 5, 4)).toBe(1);
    expect(cellAt(5, HEADER_H + CELL_H + 5, 8)).toBe(4);
    // Depois da última bancada não há nada.
    expect(cellAt(3 * CELL_W + 1, HEADER_H + 5, 3)).toBeUndefined();
    expect(cellAt(5, HEADER_H + CELL_H + 5, 3)).toBeUndefined();
  });
});
