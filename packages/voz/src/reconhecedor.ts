/**
 * Reconhecimento de fala no navegador ou no webview. Dois modos:
 * - `navegador`: a Web Speech API (SpeechRecognition / webkitSpeechRecognition),
 *   que transcreve sozinha (Chrome e Safari no celular);
 * - `gravacao`: grava o microfone com MediaRecorder e entrega o áudio a
 *   `transcrever` (no FaKL, o método `voz.transcrever` do Core). É o modo do
 *   Electron, onde a Web Speech API não funciona.
 */

import { l10n } from '@fakl/i18n';

import { normalizarDitado } from './ditado.js';

export type TipoErroDeVoz = 'sem-suporte' | 'sem-permissao' | 'sem-fala' | 'rede' | 'outro';

export interface ErroDeVoz {
  readonly tipo: TipoErroDeVoz;
  /** Mensagem em pt-BR para mostrar ao usuário. */
  readonly mensagem: string;
}

export type ModoDeVoz = 'navegador' | 'gravacao';

export type EstadoDoReconhecedor = 'parado' | 'ouvindo' | 'transcrevendo';

export interface OpcoesDoReconhecedor {
  /** Padrão: pt-BR. */
  readonly idioma?: string;
  /** Força um modo; sem ele, `navegador` quando houver, senão `gravacao`. */
  readonly modo?: ModoDeVoz;
  /** Obrigatório no modo `gravacao`: recebe o áudio e devolve o texto. */
  readonly transcrever?: (audio: Blob) => Promise<string>;
  /** Limite da gravação, em ms (padrão 120000). */
  readonly limiteMs?: number;
  /** Texto provisório enquanto a pessoa fala (só no modo `navegador`). */
  readonly onParcial?: (texto: string) => void;
  /** Texto final de cada trecho, já com `normalizarDitado`. */
  readonly onFinal?: (texto: string) => void;
  readonly onErro?: (erro: ErroDeVoz) => void;
  /** Mudança de estado: ouvindo, transcrevendo (só `gravacao`) ou parado. */
  readonly onEstado?: (estado: EstadoDoReconhecedor) => void;
}

export interface Reconhecedor {
  readonly modo: ModoDeVoz;
  readonly estado: EstadoDoReconhecedor;
  /** Pede o microfone e começa a ouvir. */
  iniciar(): Promise<void>;
  /** Para de ouvir e entrega o que falta (no modo `gravacao`, transcreve). */
  parar(): void;
  /** Para sem entregar nada. */
  cancelar(): void;
}

/**
 * O que `criarReconhecedor` lança: um `Error` que também é `ErroDeVoz`
 * (`tipo` e `mensagem`), para quem prefere `instanceof` ou só ler `tipo`.
 */
export class FalhaDeVoz extends Error implements ErroDeVoz {
  readonly tipo: TipoErroDeVoz;
  readonly mensagem: string;

  constructor(tipo: TipoErroDeVoz, mensagem: string) {
    super(mensagem);
    this.name = 'FalhaDeVoz';
    this.tipo = tipo;
    this.mensagem = mensagem;
  }
}

type Ambiente = Record<string, unknown>;

/** O que usamos de SpeechRecognition (os tipos do DOM não o trazem em todo lugar). */
interface FalaDoNavegador {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: ResultadoDeFala) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface ResultadoDeFala {
  readonly resultIndex: number;
  readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0: { transcript: string } }>;
}

interface Microfone {
  mediaDevices?: { getUserMedia?: (restricoes: { audio: boolean }) => Promise<MediaStream> };
}

/** O mesmo, depois de `suporteDeVoz` garantir que existe. */
interface MicrofoneCompleto {
  mediaDevices: { getUserMedia(restricoes: { audio: boolean }): Promise<MediaStream> };
}

const LIMITE_PADRAO_MS = 120_000;
const TIPOS_DE_AUDIO = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function msgSemPermissao(): string {
  return l10n.t(
    'No permission to use the microphone. Allow the microphone in the settings and try again.',
  );
}

/** O que o ambiente oferece. `ambiente` padrão: globalThis. */
export function suporteDeVoz(ambiente: object = globalThis): {
  navegador: boolean;
  gravacao: boolean;
} {
  const amb = ambiente as Ambiente;
  const microfone = amb.navigator as Microfone | undefined;
  return {
    navegador:
      typeof amb.SpeechRecognition === 'function' ||
      typeof amb.webkitSpeechRecognition === 'function',
    gravacao:
      typeof amb.MediaRecorder === 'function' &&
      typeof microfone?.mediaDevices?.getUserMedia === 'function',
  };
}

/** Cria um reconhecedor; lança `FalhaDeVoz` (tipo `sem-suporte`) se nenhum modo servir. */
export function criarReconhecedor(
  opcoes: OpcoesDoReconhecedor,
  ambiente: object = globalThis,
): Reconhecedor {
  const amb = ambiente as Ambiente;
  const suporte = suporteDeVoz(amb);
  const modo = opcoes.modo ?? (suporte.navegador ? 'navegador' : 'gravacao');
  if (modo === 'navegador') {
    if (!suporte.navegador) {
      throw new FalhaDeVoz('sem-suporte', l10n.t('This browser has no speech recognition.'));
    }
    return reconhecedorDoNavegador(opcoes, amb);
  }
  if (!suporte.gravacao) {
    throw new FalhaDeVoz(
      'sem-suporte',
      l10n.t('This environment cannot record audio from the microphone.'),
    );
  }
  if (!opcoes.transcrever) {
    throw new FalhaDeVoz(
      'sem-suporte',
      l10n.t('The service that transcribes the recorded audio is missing.'),
    );
  }
  return reconhecedorPorGravacao(opcoes, amb, opcoes.transcrever);
}

/** Guarda o estado e avisa `onEstado` só quando ele muda. */
function controleDeEstado(opcoes: OpcoesDoReconhecedor): {
  ver(): EstadoDoReconhecedor;
  mudar(novo: EstadoDoReconhecedor): void;
} {
  let estado: EstadoDoReconhecedor = 'parado';
  return {
    ver: () => estado,
    mudar(novo) {
      if (novo === estado) return;
      estado = novo;
      opcoes.onEstado?.(novo);
    },
  };
}

function erroDoNavegador(codigo: string): ErroDeVoz {
  switch (codigo) {
    case 'not-allowed':
    case 'service-not-allowed':
      return { tipo: 'sem-permissao', mensagem: msgSemPermissao() };
    case 'no-speech':
      return {
        tipo: 'sem-fala',
        mensagem: l10n.t(
          'I did not hear any speech. Speak closer to the microphone and try again.',
        ),
      };
    case 'network':
      return {
        tipo: 'rede',
        mensagem: l10n.t(
          'Browser speech recognition is not available here (no connection or no speech service). Use another browser or type the request.',
        ),
      };
    case 'audio-capture':
      return { tipo: 'outro', mensagem: l10n.t('I could not access the microphone.') };
    default:
      return { tipo: 'outro', mensagem: l10n.t('Speech recognition error ({0}).', codigo) };
  }
}

function reconhecedorDoNavegador(opcoes: OpcoesDoReconhecedor, amb: Ambiente): Reconhecedor {
  const Construtor = (amb.SpeechRecognition ??
    amb.webkitSpeechRecognition) as new () => FalaDoNavegador;
  const estado = controleDeEstado(opcoes);
  let atual: FalaDoNavegador | undefined;
  let descartar = false;

  return {
    modo: 'navegador',
    get estado() {
      return estado.ver();
    },
    iniciar() {
      if (estado.ver() !== 'parado') return Promise.resolve();
      descartar = false;
      const rec = new Construtor();
      rec.lang = opcoes.idioma ?? 'pt-BR';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (ev) => {
        if (descartar || atual !== rec) return;
        let provisorio = '';
        for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
          const resultado = ev.results[i];
          const texto = resultado?.[0].transcript ?? '';
          if (!resultado?.isFinal) {
            provisorio += texto;
          } else if (texto.trim() !== '') {
            opcoes.onFinal?.(normalizarDitado(texto.trim()));
          }
        }
        opcoes.onParcial?.(provisorio);
      };
      rec.onerror = (ev) => {
        if (descartar || atual !== rec || ev.error === 'aborted') return;
        opcoes.onErro?.(erroDoNavegador(ev.error));
      };
      // O Chrome encerra sozinho depois de um silêncio, mesmo em modo contínuo.
      rec.onend = () => {
        if (atual !== rec) return;
        atual = undefined;
        estado.mudar('parado');
      };
      atual = rec;
      try {
        rec.start();
        estado.mudar('ouvindo');
      } catch (erro) {
        atual = undefined;
        opcoes.onErro?.({
          tipo: 'outro',
          mensagem: l10n.t('I could not start speech recognition: {0}', mensagemDe(erro)),
        });
      }
      return Promise.resolve();
    },
    parar() {
      atual?.stop();
    },
    cancelar() {
      descartar = true;
      const rec = atual;
      atual = undefined;
      rec?.abort();
      estado.mudar('parado');
    },
  };
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

function erroDoMicrofone(erro: unknown): ErroDeVoz {
  const nome = (erro as { name?: unknown } | null)?.name;
  if (nome === 'NotAllowedError' || nome === 'SecurityError') {
    return { tipo: 'sem-permissao', mensagem: msgSemPermissao() };
  }
  if (nome === 'NotFoundError' || nome === 'OverconstrainedError') {
    return { tipo: 'outro', mensagem: l10n.t('No microphone found.') };
  }
  return { tipo: 'outro', mensagem: l10n.t('Could not use the microphone: {0}', mensagemDe(erro)) };
}

function reconhecedorPorGravacao(
  opcoes: OpcoesDoReconhecedor,
  amb: Ambiente,
  transcrever: (audio: Blob) => Promise<string>,
): Reconhecedor {
  const Gravador = amb.MediaRecorder as typeof MediaRecorder;
  const microfone = amb.navigator as MicrofoneCompleto;
  const estado = controleDeEstado(opcoes);
  let gravador: MediaRecorder | undefined;
  let trilhas: MediaStream | undefined;
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  let partes: Blob[] = [];
  let descartar = false;
  // Cada início tem sua geração; só a atual vale depois do await da permissão.
  let geracao = 0;
  let adquirindo = false;
  // Função, não leitura direta: o TypeScript não vê a mudança feita por `cancelar` durante um await.
  const cancelado = (): boolean => descartar;

  const soltarMicrofone = (): void => {
    if (temporizador !== undefined) clearTimeout(temporizador);
    temporizador = undefined;
    trilhas?.getTracks().forEach((t) => {
      t.stop();
    });
    trilhas = undefined;
  };

  const terminar = async (tipo: string): Promise<void> => {
    soltarMicrofone();
    gravador = undefined;
    const audio = new Blob(partes, { type: tipo });
    partes = [];
    if (cancelado()) {
      estado.mudar('parado');
      return;
    }
    estado.mudar('transcrevendo');
    try {
      const texto = normalizarDitado((await transcrever(audio)).trim());
      if (cancelado()) return;
      if (texto === '') {
        opcoes.onErro?.({
          tipo: 'sem-fala',
          mensagem: l10n.t('I did not understand any speech in the recording.'),
        });
      } else {
        opcoes.onFinal?.(texto);
      }
    } catch (erro) {
      if (!cancelado()) {
        opcoes.onErro?.({
          tipo: 'outro',
          mensagem: l10n.t('Could not transcribe the audio: {0}', mensagemDe(erro)),
        });
      }
    }
    estado.mudar('parado');
  };

  const parar = (): void => {
    if (estado.ver() !== 'ouvindo' || !gravador) return;
    if (temporizador !== undefined) clearTimeout(temporizador);
    temporizador = undefined;
    gravador.stop();
  };

  return {
    modo: 'gravacao',
    get estado() {
      return estado.ver();
    },
    async iniciar() {
      if (estado.ver() !== 'parado' || adquirindo) return;
      descartar = false;
      partes = [];
      const minha = ++geracao;
      adquirindo = true;
      let fluxo: MediaStream;
      try {
        fluxo = await microfone.mediaDevices.getUserMedia({ audio: true });
      } catch (erro) {
        if (minha === geracao) {
          adquirindo = false;
          opcoes.onErro?.(erroDoMicrofone(erro));
        }
        return;
      }
      if (minha !== geracao || cancelado()) {
        fluxo.getTracks().forEach((t) => {
          t.stop();
        });
        return;
      }
      adquirindo = false;
      trilhas = fluxo;
      try {
        const tipo =
          typeof Gravador.isTypeSupported === 'function'
            ? TIPOS_DE_AUDIO.find((t) => Gravador.isTypeSupported(t))
            : undefined;
        const rec = new Gravador(fluxo, tipo ? { mimeType: tipo } : undefined);
        rec.ondataavailable = (ev) => {
          if (ev.data.size > 0) partes.push(ev.data);
        };
        rec.onstop = () => {
          void terminar(rec.mimeType === '' ? (tipo ?? '') : rec.mimeType);
        };
        gravador = rec;
        rec.start();
      } catch (erro) {
        soltarMicrofone();
        gravador = undefined;
        opcoes.onErro?.({
          tipo: 'outro',
          mensagem: l10n.t('Could not record the audio: {0}', mensagemDe(erro)),
        });
        return;
      }
      estado.mudar('ouvindo');
      temporizador = setTimeout(parar, opcoes.limiteMs ?? LIMITE_PADRAO_MS);
    },
    parar,
    cancelar() {
      descartar = true;
      if (adquirindo) {
        // O fluxo que ainda vem da permissão fica obsoleto: ao chegar, é solto.
        geracao += 1;
        adquirindo = false;
      }
      if (estado.ver() === 'ouvindo' && gravador) {
        gravador.stop();
      } else if (estado.ver() === 'parado') {
        soltarMicrofone();
      }
    },
  };
}

/** Base64 do conteúdo do blob, sem o prefixo `data:`, para `voz.transcrever`. */
export async function blobParaBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binario = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(binario);
}
