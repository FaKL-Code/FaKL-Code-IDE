/** Comandos por voz (`voz.*`): o modo escolhido e a transcrição de áudio no Core. */

/**
 * Modos de voz. A voz começa desligada (sem modo) até a pessoa escolher um:
 * - `navegador`: a Web Speech API do navegador do celular reconhece a fala;
 *   grátis e sem chave, mas não funciona no Electron da IDE;
 * - `openai`, `groq`: o Core manda o áudio gravado à API do provedor (chave no cofre);
 * - `local`: o Core manda o áudio a um servidor compatível com a rota
 *   `/audio/transcriptions` da OpenAI (speaches, faster-whisper-server, whisper.cpp).
 */
export const VOZ_MODOS = ['navegador', 'openai', 'groq', 'local'] as const;
export type VozModo = (typeof VOZ_MODOS)[number];

/** Modos em que o Core transcreve o áudio (`voz.transcrever`). */
export const VOZ_MODOS_NO_CORE = ['openai', 'groq', 'local'] as const;
export type VozModoNoCore = (typeof VOZ_MODOS_NO_CORE)[number];

export function isVozModo(value: unknown): value is VozModo {
  return typeof value === 'string' && (VOZ_MODOS as readonly string[]).includes(value);
}

/** `voz.transcrever`: áudio gravado pelo webview da IDE ou pelo celular. */
export interface VozTranscreverParams {
  /** Áudio em base64 (sem o prefixo `data:`). */
  readonly audio: string;
  /** Tipo do áudio, por exemplo `audio/webm;codecs=opus` ou `audio/mp4`. */
  readonly mime: string;
  /** Idioma da fala (padrão: o do config.yaml, senão pt-BR). */
  readonly idioma?: string;
}

export interface VozTranscreverResult {
  readonly texto: string;
}

/** `voz.status`: se a voz está pronta e em que modo. */
export interface VozStatus {
  /** Um modo foi escolhido e tem o que precisa (a chave, nos provedores com API). */
  readonly configurado: boolean;
  /** Modo escolhido; sem ele, a voz está desligada. */
  readonly modo?: VozModo;
  /** Nos modos do Core, o mesmo que `modo` (mantido para clientes antigos). */
  readonly provedor?: VozModoNoCore;
  readonly modelo?: string;
  /** Servidor de transcrição (modos do Core). */
  readonly endpoint?: string;
  /** Por que não está pronta, em pt-BR. */
  readonly motivo?: string;
}

/**
 * Quem transcreve com este status: o Core (áudio gravado), o navegador (Web
 * Speech API) ou ninguém. Status de Core antigo, sem `modo`, conta como Core.
 */
export function transcricaoDaVoz(status: VozStatus | undefined): 'core' | 'navegador' | undefined {
  if (!status?.configurado) return undefined;
  if (status.modo === 'navegador') return 'navegador';
  return 'core';
}

/**
 * `voz.configurar`: escolhe o modo e grava `voz:` no config.yaml. `modo: null`
 * desliga a voz. Sem `modelo` e `endpoint`, valem os padrões do provedor; a
 * chave da API não passa por aqui (vai ao cofre, `secrets.set voz.token`).
 */
export interface VozConfigurarParams {
  readonly modo: VozModo | null;
  readonly modelo?: string;
  readonly endpoint?: string;
  readonly idioma?: string;
}
