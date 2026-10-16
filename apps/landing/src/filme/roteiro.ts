/*
 * A página é montada como uma composição HyperFrames: cada seção é um clipe
 * com início e duração na mesma linha do tempo do filme, e as legendas viram
 * os passos de texto da seção. Os textos (rótulos e passos) ficam em src/i18n. Os tempos são do filme, em segundos, e mudam
 * entre o corte 16:9 (h) e o 9:16 (v).
 *
 * Módulo só de dados: o Astro monta o HTML com ele e o filme.ts liga a rolagem.
 */

export type Orientacao = 'h' | 'v';

/** Como o monitor da seção fica na página. */
export type Arranjo = 'tela' | 'direita' | 'esquerda' | 'largo';

export interface Passo {
  /** Quando o passo entra, em cada corte. */
  readonly h: number;
  readonly v: number;
}

export interface Clipe {
  readonly id: string;
  /** Nome do arquivo da cena no projeto do filme. */
  readonly arquivo: string;
  readonly arranjo: Arranjo;
  readonly h: readonly [number, number];
  readonly v: readonly [number, number];
  readonly passos: readonly Passo[];
}

/** O gancho digita sozinho até aqui; a rolagem assume depois. */
export const INTRO = 5.0;

/** Duração total de cada corte. */
export const DURACAO: Record<Orientacao, number> = { h: 72.0, v: 59.368 };

/** A partir daqui, no último clipe, aparecem os botões de baixar. */
export const FIM: Record<Orientacao, number> = { h: 65.6, v: 54.2 };

export const CLIPES: readonly Clipe[] = [
  {
    id: 'gancho',
    arquivo: '01-gancho',
    arranjo: 'tela',
    h: [0, 6.316],
    v: [0, 6.316],
    passos: [],
  },
  {
    id: 'cafe',
    arquivo: '02-cafe',
    arranjo: 'direita',
    h: [6.316, 21.474],
    v: [6.316, 16.421],
    passos: [
      { h: 6.75, v: 6.75 },
      { h: 11.6, v: 9.8 },
      { h: 16.4, v: 13.0 },
    ],
  },
  {
    id: 'mesa',
    arquivo: '03-mesa',
    arranjo: 'largo',
    h: [21.474, 29.053],
    v: [16.421, 26.526],
    passos: [
      { h: 22.45, v: 19.9 },
      { h: 24.5, v: 21.97 },
      { h: 26.6, v: 24.07 },
    ],
  },
  {
    id: 'chat',
    arquivo: '04-chat',
    arranjo: 'esquerda',
    h: [29.053, 34.105],
    v: [26.526, 31.579],
    passos: [
      { h: 29.25, v: 26.7 },
      { h: 31.4, v: 28.9 },
    ],
  },
  {
    id: 'estacoes',
    arquivo: '05-estacoes',
    arranjo: 'direita',
    h: [34.105, 46.737],
    v: [31.579, 44.211],
    passos: [
      { h: 34.35, v: 31.83 },
      { h: 36.88, v: 34.36 },
      { h: 39.4, v: 36.88 },
      { h: 41.93, v: 39.41 },
      { h: 44.46, v: 41.94 },
    ],
  },
  {
    id: 'celular',
    arquivo: '06-celular',
    arranjo: 'esquerda',
    h: [46.737, 61.895],
    v: [44.211, 49.263],
    passos: [
      { h: 47.4, v: 44.5 },
      { h: 56.9, v: 47.3 },
    ],
  },
  {
    id: 'marca',
    arquivo: '07-marca',
    arranjo: 'tela',
    h: [61.895, 72.0],
    v: [49.263, 59.368],
    passos: [],
  },
];

/**
 * Peso da rolagem por trecho do filme: mais que 1 dá mais rolagem por segundo
 * (o trecho anda devagar), menos que 1 anda mais rápido.
 */
export const RITMO: Record<Orientacao, readonly (readonly [number, number, number])[]> = {
  h: [
    [21.474, 22.6, 2.4],
    [46.737, 61.895, 0.75],
    [66, 72, 0.4],
  ],
  v: [
    [16.421, 18.947, 0.8],
    [18.947, 20.0, 2.4],
    [54.5, 59.368, 0.4],
  ],
};

/** Tempo do filme em "mm:ss:qq", com quadros de 30 fps. */
export function timecode(t: number): string {
  const q = Math.max(0, Math.round(t * 30));
  const mm = Math.floor(q / 1800);
  const ss = Math.floor(q / 30) % 60;
  const ff = q % 30;
  return [mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':');
}
