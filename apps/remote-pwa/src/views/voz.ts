import { l10n } from '@fakl/i18n';
import type { VozStatus, VozTranscreverResult } from '@fakl/protocol';
import {
  criarReconhecedor,
  juntarDitado,
  suporteDeVoz,
  type ErroDeVoz,
  type EstadoDoReconhecedor,
  type ModoDeVoz,
  type Reconhecedor,
} from '@fakl/voz';

import { app } from '../app.js';
import { h, icon, toast } from '../dom.js';
import { dicaSemVoz, escolherModoDeVoz } from '../voz-modo.js';

/** Campo onde o ditado cai. */
export type CampoDeDitado = HTMLTextAreaElement | HTMLInputElement;

export interface Ditado {
  /** Botão de microfone para pôr ao lado do campo. */
  readonly botao: HTMLButtonElement;
  readonly estado: () => EstadoDoReconhecedor;
  /** Começa a ouvir (nada acontece se já está ouvindo ou sem suporte). */
  iniciar(): Promise<void>;
  /** Para de ouvir e entrega o que falta. */
  parar(): void;
  /** Para sem entregar nada; usar ao fechar a tela. */
  cancelar(): void;
}

function rotulo(estado: EstadoDoReconhecedor): string {
  switch (estado) {
    case 'parado':
      return l10n.t('Speak');
    case 'ouvindo':
      return l10n.t('Stop listening');
    case 'transcrevendo':
      return l10n.t('Transcribing…');
  }
}

/** Quanto tempo vale a resposta do `voz.status`: o modo pode mudar na IDE. */
const STATUS_VALE_MS = 30_000;

/** Resposta do `voz.status` guardada por pouco tempo; falhas não ficam guardadas. */
let statusCore: { quando: number; status: Promise<VozStatus | undefined> } | undefined;

/** Pergunta à IDE o modo de voz; sem conexão ou sem resposta, `undefined`. */
function statusDaVoz(): Promise<VozStatus | undefined> {
  const session = app.session;
  if (!session) return Promise.resolve(undefined);
  if (statusCore && Date.now() - statusCore.quando < STATUS_VALE_MS) return statusCore.status;
  const atual = {
    quando: Date.now(),
    status: session.request<VozStatus>('voz.status').catch(() => {
      if (statusCore === atual) statusCore = undefined;
      return undefined;
    }),
  };
  statusCore = atual;
  return atual.status;
}

/**
 * Modo de voz deste aparelho, pelo modo escolhido na IDE: o navegador
 * (Web Speech API) no modo navegador, a gravação nos modos do Core; senão
 * `undefined` e o motivo.
 */
export async function modoDeVoz(): Promise<{ modo?: ModoDeVoz; dica: string }> {
  const { modo, dica } = escolherModoDeVoz(suporteDeVoz(), await statusDaVoz());
  return modo ? { modo, dica: rotulo('parado') } : { dica: dica ?? dicaSemVoz() };
}

/** Áudio gravado em base64, sem o prefixo `data:`. */
export function blobParaBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => {
      reject(new Error(l10n.t("Couldn't read the recorded audio.")));
    };
    leitor.onload = () => {
      const url = typeof leitor.result === 'string' ? leitor.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    leitor.readAsDataURL(blob);
  });
}

async function transcrever(audio: Blob): Promise<string> {
  const session = app.session;
  if (!session) throw new Error(l10n.t('No connection to the IDE.'));
  const resultado = await session.request<VozTranscreverResult>('voz.transcrever', {
    audio: await blobParaBase64(audio),
    mime: audio.type || 'audio/webm',
    idioma: 'pt-BR',
  });
  return resultado.texto;
}

/**
 * Liga um reconhecedor a um campo: o texto provisório aparece no próprio
 * campo enquanto a pessoa fala e cada trecho final entra com `juntarDitado`.
 * `aoMudar` roda a cada mudança do texto ou do estado (para altura, interpretação).
 */
export function criarDitado(campo: CampoDeDitado, aoMudar?: () => void): Ditado {
  let estado: EstadoDoReconhecedor = 'parado';
  let reconhecedor: Reconhecedor | undefined;
  /** Texto do campo antes do trecho que está sendo falado. */
  let base = '';
  let tentando = false;

  const botao = h(
    'button',
    {
      class: 'microfone',
      type: 'button',
      'aria-label': rotulo('parado'),
      'aria-pressed': 'false',
      title: rotulo('parado'),
    },
    icon('microfone', 20),
  );

  const escrever = (texto: string): void => {
    campo.value = texto;
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    aoMudar?.();
  };

  const pintar = (novo: EstadoDoReconhecedor): void => {
    estado = novo;
    botao.classList.toggle('ouvindo', novo === 'ouvindo');
    botao.classList.toggle('transcrevendo', novo === 'transcrevendo');
    botao.setAttribute('aria-pressed', String(novo === 'ouvindo'));
    botao.setAttribute('aria-label', rotulo(novo));
    botao.title = rotulo(novo);
    botao.setAttribute('aria-busy', String(novo === 'transcrevendo'));
    aoMudar?.();
  };

  const erro = (e: ErroDeVoz): void => {
    toast(e.mensagem, 'erro');
  };

  const desabilitar = (dica: string): void => {
    botao.disabled = true;
    botao.title = dica;
    botao.setAttribute('aria-label', l10n.t('Speak (unavailable): {0}', dica));
  };

  // O botão só vale com um modo de voz escolhido na IDE que este aparelho atenda.
  botao.disabled = true;
  void modoDeVoz().then(({ modo, dica }) => {
    if (modo) {
      botao.disabled = false;
      botao.title = dica;
    } else desabilitar(dica);
  });

  const iniciar = async (): Promise<void> => {
    if (estado !== 'parado' || tentando || botao.disabled) return;
    tentando = true;
    try {
      const { modo, dica } = await modoDeVoz();
      if (!modo) {
        desabilitar(dica);
        toast(dica, 'erro');
        return;
      }
      base = campo.value;
      reconhecedor = criarReconhecedor({
        idioma: 'pt-BR',
        modo,
        ...(modo === 'gravacao' ? { transcrever } : {}),
        onParcial: (texto) => {
          escrever(juntarDitado(base, texto));
        },
        onFinal: (texto) => {
          base = juntarDitado(base, texto);
          escrever(base);
        },
        onErro: (e) => {
          // Volta ao que valia antes do trecho que não deu certo.
          if (campo.value !== base) escrever(base);
          erro(e);
        },
        onEstado: pintar,
      });
      await reconhecedor.iniciar();
    } catch (e) {
      pintar('parado');
      const conhecido = e as Partial<ErroDeVoz>;
      toast(conhecido.mensagem ?? l10n.t("Couldn't use the microphone."), 'erro');
    } finally {
      tentando = false;
    }
  };

  botao.addEventListener('click', () => {
    if (estado === 'ouvindo') reconhecedor?.parar();
    else if (estado === 'parado') void iniciar();
  });

  return {
    botao,
    estado: () => estado,
    iniciar,
    parar: () => {
      reconhecedor?.parar();
    },
    cancelar: () => {
      reconhecedor?.cancelar();
      reconhecedor = undefined;
      pintar('parado');
    },
  };
}
