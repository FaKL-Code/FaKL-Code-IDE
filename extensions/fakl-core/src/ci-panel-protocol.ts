import type { CiStatus, FaklEvent } from '@fakl/protocol';

/** Mensagens da extensão para a cozinha do CI. */
export type ToCozinha =
  | { readonly type: 'status'; readonly status: CiStatus }
  | { readonly type: 'event'; readonly event: FaklEvent }
  /** Depois de quantos minutos uma execução com sucesso ou cancelada sai sozinha (0 desliga). */
  | { readonly type: 'config'; readonly saemAposMin: number }
  | { readonly type: 'offline' };

/** Mensagens da cozinha do CI para a extensão. */
export type FromCozinha =
  | { readonly type: 'ready' }
  /** Consulta o GitHub agora (vale com a consulta automática desligada). */
  | { readonly type: 'atualizar' }
  | { readonly type: 'abrir'; readonly repo: string; readonly id: number; readonly url: string }
  /** Sem repositório acompanhado: abre a escolha. */
  | { readonly type: 'acompanhar' };
