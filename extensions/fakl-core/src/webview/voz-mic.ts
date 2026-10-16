import { l10n } from '@fakl/i18n';
import type { VozStatus } from '@fakl/protocol';
import {
  criarReconhecedor,
  juntarDitado,
  type ErroDeVoz,
  type EstadoDoReconhecedor,
  type Reconhecedor,
} from '@fakl/voz';

import { bytesParaBase64, vozNaIde } from '../voz-model.js';
import type { FromVoz, ToVoz } from '../voz-protocol.js';

/**
 * Microfone dos webviews (chat, Mesa e "Falar um pedido"). Grava com
 * MediaRecorder (modo `gravacao` do @fakl/voz: no Electron a Web Speech API
 * não funciona) e manda o áudio ao host, que pede a transcrição ao Core.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const DESENHOS = {
  mic: '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5M8.8 20.5h6.4"/>',
  parar: '<rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none"/>',
  girando: '<path d="M20.5 12a8.5 8.5 0 1 1-5.8-8.06"/>',
} as const;

/** Atalho do microfone como aparece na tela (o nome da tecla muda com o idioma). */
export function atalhoDeVoz(): string {
  return l10n.t('Ctrl+Shift+Space');
}

function semPermissao(): string {
  return l10n.t(
    "The IDE couldn't use the microphone. Allow microphone access in the system settings or, for now, use Windows dictation (Win+H) right in the field.",
  );
}

export function desenho(nome: keyof typeof DESENHOS, tamanho = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(tamanho));
  svg.setAttribute('height', String(tamanho));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon voz-icone voz-${nome}`);
  svg.innerHTML = DESENHOS[nome];
  return svg;
}

/** Ctrl+Shift+Espaço (Cmd no Mac) liga e desliga o microfone do campo em foco. */
export function ehAtalhoDeVoz(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'Space';
}

/** Mensagem no idioma da IDE para um erro do reconhecedor ou da transcrição. */
export function mensagemDeErro(erro: unknown): string {
  if (erro && typeof erro === 'object' && 'tipo' in erro && 'mensagem' in erro) {
    const deVoz = erro as ErroDeVoz;
    return deVoz.tipo === 'sem-permissao' ? semPermissao() : deVoz.mensagem;
  }
  if (erro instanceof DOMException && erro.name === 'NotAllowedError') return semPermissao();
  return erro instanceof Error ? erro.message : String(erro);
}

/** Transcrição pelo host: manda o áudio e espera `vozTexto` ou `vozErro`. */
export interface Transcritor {
  transcrever(audio: Blob): Promise<string>;
  /** Trata as respostas do host; devolve true quando a mensagem era de voz. */
  receber(message: { readonly type: string }): boolean;
}

export function criarTranscritor(post: (message: FromVoz) => void): Transcritor {
  let proximo = 1;
  const esperando = new Map<number, { ok(texto: string): void; falha(erro: Error): void }>();
  return {
    async transcrever(audio) {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const requestId = proximo++;
      return new Promise<string>((ok, falha) => {
        esperando.set(requestId, { ok, falha });
        post({
          type: 'vozTranscrever',
          requestId,
          audio: bytesParaBase64(bytes),
          mime: audio.type || 'audio/webm',
        });
      });
    },
    receber(message) {
      const voz = message as ToVoz;
      if (voz.type !== 'vozTexto' && voz.type !== 'vozErro') return false;
      const espera = esperando.get(voz.requestId);
      esperando.delete(voz.requestId);
      if (voz.type === 'vozTexto') espera?.ok(voz.texto);
      else espera?.falha(new Error(voz.mensagem));
      return true;
    },
  };
}

export interface Microfone {
  readonly botao: HTMLButtonElement;
  readonly estado: EstadoDoReconhecedor;
  /** Começa a gravar ou para e transcreve. */
  alternar(): void;
  /** Para de gravar sem transcrever. */
  cancelar(): void;
  /** Sem status (Core fora do ar) o botão some; sem voz pronta na IDE, leva a "Configurar voz". */
  definirStatus(status: VozStatus | undefined): void;
}

export interface OpcoesDoMicrofone {
  /** Campo que recebe o texto ditado, junto do que já estava escrito. */
  readonly campo: HTMLTextAreaElement;
  readonly transcrever: (audio: Blob) => Promise<string>;
  readonly onErro: (mensagem: string) => void;
  readonly onConfigurar: () => void;
  readonly onEstado?: (estado: EstadoDoReconhecedor) => void;
  /** Classe do botão (padrão `voz-mic`). */
  readonly classe?: string;
  readonly tamanhoIcone?: number;
  /** Usar `title` em vez de `data-tip` (a Mesa não tem os tooltips do chat). */
  readonly title?: boolean;
}

export function criarMicrofone(opcoes: OpcoesDoMicrofone): Microfone {
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = opcoes.classe ?? 'voz-mic';
  botao.hidden = true;
  const tamanho = opcoes.tamanhoIcone ?? 16;
  let status: VozStatus | undefined;
  let estado: EstadoDoReconhecedor = 'parado';
  let reconhecedor: Reconhecedor | undefined;

  const dica = (texto: string): void => {
    botao.setAttribute('aria-label', texto);
    if (opcoes.title) botao.title = texto;
    else botao.dataset.tip = texto;
  };

  const desenhar = (): void => {
    botao.dataset.estado = estado;
    const ide = vozNaIde(status);
    botao.classList.toggle('off', !ide.pronta);
    botao.setAttribute('aria-pressed', String(estado === 'ouvindo'));
    botao.disabled = estado === 'transcrevendo';
    if (status && !ide.pronta) {
      botao.replaceChildren(desenho('mic', tamanho));
      dica(
        l10n.t('{0} Click to choose the voice mode.', ide.aviso ?? l10n.t('Voice unavailable.')),
      );
      return;
    }
    if (estado === 'ouvindo') {
      botao.replaceChildren(desenho('parar', tamanho));
      dica(l10n.t('Listening… click to stop and transcribe ({0})', atalhoDeVoz()));
    } else if (estado === 'transcrevendo') {
      botao.replaceChildren(desenho('girando', tamanho));
      dica(l10n.t('Transcribing…'));
    } else {
      botao.replaceChildren(desenho('mic', tamanho));
      dica(l10n.t('Dictate ({0})', atalhoDeVoz()));
    }
  };

  const mudar = (proximo: EstadoDoReconhecedor): void => {
    estado = proximo;
    if (proximo === 'parado') reconhecedor = undefined;
    desenhar();
    opcoes.onEstado?.(proximo);
  };

  const inserir = (texto: string): void => {
    if (!texto.trim()) return;
    const { campo } = opcoes;
    campo.value = juntarDitado(campo.value, texto);
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    campo.focus();
    campo.setSelectionRange(campo.value.length, campo.value.length);
  };

  const iniciar = (): void => {
    try {
      const atual = criarReconhecedor({
        modo: 'gravacao',
        idioma: 'pt-BR',
        transcrever: opcoes.transcrever,
        onFinal: inserir,
        onErro: (erro) => {
          opcoes.onErro(mensagemDeErro(erro));
        },
        onEstado: (proximo) => {
          if (reconhecedor === atual) mudar(proximo);
        },
      });
      reconhecedor = atual;
      atual.iniciar().catch((erro: unknown) => {
        if (reconhecedor === atual) mudar('parado');
        opcoes.onErro(mensagemDeErro(erro));
      });
    } catch (erro) {
      mudar('parado');
      opcoes.onErro(mensagemDeErro(erro));
    }
  };

  const microfone: Microfone = {
    botao,
    get estado() {
      return estado;
    },
    alternar() {
      if (botao.hidden || estado === 'transcrevendo') return;
      if (!vozNaIde(status).pronta) {
        opcoes.onConfigurar();
        return;
      }
      if (estado === 'ouvindo' && reconhecedor) reconhecedor.parar();
      // Aguardando a permissão (reconhecedor já criado, ainda parado): não abre outro.
      else if (!reconhecedor) iniciar();
    },
    cancelar() {
      const atual = reconhecedor;
      if (!atual) return;
      reconhecedor = undefined;
      atual.cancelar();
      mudar('parado');
    },
    definirStatus(proximo) {
      status = proximo;
      botao.hidden = proximo === undefined;
      if (!vozNaIde(proximo).pronta) microfone.cancelar();
      desenhar();
    },
  };
  botao.addEventListener('click', () => {
    microfone.alternar();
  });
  desenhar();
  return microfone;
}
