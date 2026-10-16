export interface VaultGraphData {
  readonly nodes: readonly { readonly path: string; readonly title: string }[];
  readonly edges: readonly (readonly [string, string])[];
}

/** Mensagens da extensão para o grafo. */
export type GraphToWebview =
  | { readonly type: 'graph'; readonly graph: VaultGraphData; readonly current?: string }
  | { readonly type: 'current'; readonly path: string };

/** Mensagens do grafo para a extensão. */
export type GraphFromWebview =
  { readonly type: 'ready' } | { readonly type: 'open'; readonly path: string };
