/**
 * Mensagens das dicas do tour entre as telas da FaKL (webviews) e a extensão.
 * Os tipos levam o prefixo `fakl.dicas` para não esbarrar nos protocolos
 * próprios de cada tela, que ignoram o que não conhecem.
 */

export type TourSurface = 'mesa' | 'chat' | 'cafe' | 'vault';

export interface TourTip {
  readonly id: string;
  readonly superficie: TourSurface;
  /** Seletor CSS do elemento que o balão aponta, dentro da webview. */
  readonly alvo: string;
  readonly texto: string;
}

/** A dica como a página a recebe: sem a superfície, que ela já sabe. */
export type TipView = Pick<TourTip, 'id' | 'alvo' | 'texto'>;

export interface ToTips {
  readonly type: 'fakl.dicas';
  readonly dicas: readonly TipView[];
  readonly rotulos: { readonly entendi: string; readonly desligar: string };
}

export type FromTips =
  | { readonly type: 'fakl.dicas.pronto'; readonly superficie: TourSurface }
  | { readonly type: 'fakl.dicas.vista'; readonly id: string }
  | { readonly type: 'fakl.dicas.desligar' };
