import type { VozStatus } from '@fakl/protocol';
import type { ContextoDeVoz, PedidoDeVoz } from '@fakl/voz';

/**
 * Mensagens de voz que o chat, a Mesa e o painel "Falar um pedido" trocam com
 * a extensão. O webview grava o microfone; quem transcreve é o Core
 * (`voz.transcrever`), pelo host, porque no Electron a Web Speech API não
 * funciona e o webview não fala com o Core.
 */

/** Da extensão para o webview. */
export type ToVoz =
  /** Sem status, o Core não está respondendo e o microfone some. */
  | { readonly type: 'vozStatus'; readonly status?: VozStatus }
  | { readonly type: 'vozTexto'; readonly requestId: number; readonly texto: string }
  | { readonly type: 'vozErro'; readonly requestId: number; readonly mensagem: string };

/** Do webview para a extensão. */
export type FromVoz =
  | {
      readonly type: 'vozTranscrever';
      readonly requestId: number;
      /** Áudio em base64, sem o prefixo `data:`. */
      readonly audio: string;
      readonly mime: string;
    }
  /** Abre "FaKL: Configurar voz". */
  | { readonly type: 'vozConfigurar' };

/** Painel "Falar um pedido": da extensão para o webview. */
export type ToFalar =
  | ToVoz
  | {
      readonly type: 'init';
      readonly contexto: ContextoDeVoz;
      readonly status: VozStatus;
      /** Começar a gravar assim que abrir. */
      readonly gravar: boolean;
    }
  | { readonly type: 'erro'; readonly mensagem: string };

/** Painel "Falar um pedido": do webview para a extensão. */
export type FromFalar =
  | FromVoz
  | { readonly type: 'ready' }
  | { readonly type: 'enviar'; readonly pedido: PedidoDeVoz }
  | { readonly type: 'fechar' };

export function isFromVoz(message: { readonly type: string }): message is FromVoz {
  return message.type === 'vozTranscrever' || message.type === 'vozConfigurar';
}
