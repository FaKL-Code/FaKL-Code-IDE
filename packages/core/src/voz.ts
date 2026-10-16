import { l10n } from '@fakl/i18n';
import {
  FaklErrorCode,
  isVozModo,
  VOZ_MODOS,
  type VozConfigurarParams,
  type VozStatus,
  type VozTranscreverResult,
} from '@fakl/protocol';

import type { VozConfig } from './config.js';
import { objectParams, RpcError, stringParam, type Router } from './rpc/router.js';
import type { SecretVault } from './secrets.js';

const TIMEOUT_MS = 60_000;
/** Nome do provedor nas mensagens; traduzido na hora, não no topo do módulo. */
function providerName(modo: 'openai' | 'groq' | 'local'): string {
  if (modo === 'openai') return 'OpenAI';
  if (modo === 'groq') return 'Groq';
  return l10n.t('the local server');
}
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface VozServiceOptions {
  /** Config atual (`voz:` do config.yaml); lida a cada chamada para valer após recarregar. */
  readonly config: () => VozConfig | undefined;
  /** Grava `voz:` no config.yaml (`voz.configurar`); sem ele, o método recusa. */
  readonly save?: (change: VozConfigurarParams) => Promise<unknown>;
  readonly secrets: SecretVault;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Extensão do arquivo enviado ao provedor, que a usa para reconhecer o formato. */
function extensionFor(mime: string): string {
  const type = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.includes('webm')) return 'webm';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  return 'webm';
}

/**
 * Transcrição de voz (`voz.*`). Fala com qualquer servidor que exponha a rota
 * `/audio/transcriptions` da OpenAI (OpenAI, Groq, speaches, whisper.cpp). O
 * áudio só passa pela memória: não é gravado em disco nem registrado em log.
 */
export class VozService {
  constructor(private readonly options: VozServiceOptions) {}

  status(): VozStatus {
    const config = this.options.config();
    if (!config) {
      return {
        configurado: false,
        motivo: l10n.t('Voice is off: choose a mode ({0})', VOZ_MODOS.join(', ')),
      };
    }
    if (config.modo === 'navegador') return { configurado: true, modo: 'navegador' };
    const base = {
      modo: config.modo,
      provedor: config.modo,
      modelo: config.modelo,
      endpoint: config.endpoint,
    };
    if (config.modo !== 'local' && !this.options.secrets.has('voz.token')) {
      return {
        configurado: false,
        ...base,
        motivo: l10n.t('Missing the {0} API key (secret voz.token)', providerName(config.modo)),
      };
    }
    return { configurado: true, ...base };
  }

  /** Escolhe o modo (ou desliga a voz, com `modo: null`) e devolve o status novo. */
  async configurar(params: VozConfigurarParams): Promise<VozStatus> {
    if (!this.options.save) throw RpcError.invalidParams(l10n.t('Settings unavailable'));
    try {
      await this.options.save(params);
    } catch (error) {
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
    return this.status();
  }

  async transcrever(params: {
    audio: string;
    mime: string;
    idioma?: string;
  }): Promise<VozTranscreverResult> {
    const config = this.options.config();
    const status = this.status();
    if (!config || !status.configurado) {
      throw new RpcError(
        FaklErrorCode.ProviderUnavailable,
        l10n.t('Voice not configured: {0}', status.motivo ?? l10n.t('no configuration')),
      );
    }
    if (config.modo === 'navegador') {
      throw new RpcError(
        FaklErrorCode.ProviderUnavailable,
        l10n.t('Voice is in browser mode: the browser recognizes speech, not the Core'),
      );
    }
    const provedor = providerName(config.modo);
    const mime = params.mime.trim();
    if (!/^audio\//i.test(mime) && !/^video\/webm/i.test(mime)) {
      throw RpcError.invalidParams(l10n.t('mime must be audio (audio/* or video/webm)'));
    }
    const audio = params.audio.replace(/\s+/g, '');
    if (!audio || audio.length % 4 !== 0 || !BASE64.test(audio)) {
      throw RpcError.invalidParams(l10n.t('audio must be valid base64'));
    }
    const bytes = Buffer.from(audio, 'base64');
    const limit = config.limiteMb * 1024 * 1024;
    if (bytes.length > limit) {
      throw new RpcError(
        FaklErrorCode.LimitExceeded,
        l10n.t(
          'Audio too large ({0} MB; the limit is {1} MB)',
          (bytes.length / 1024 / 1024).toFixed(1),
          String(config.limiteMb),
        ),
      );
    }

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), `fala.${extensionFor(mime)}`);
    form.append('model', config.modelo);
    const language = (params.idioma ?? config.idioma).split(/[-_]/)[0]?.toLowerCase();
    if (language) form.append('language', language);
    form.append('response_format', 'json');

    const token = this.options.secrets.get('voz.token');
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const url = `${config.endpoint}/audio/transcriptions`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      throw new RpcError(
        FaklErrorCode.ProviderUnavailable,
        timeout
          ? l10n.t(
              'The transcription took more than {0} s with no response from {1}',
              String(TIMEOUT_MS / 1000),
              provedor,
            )
          : l10n.t('Could not reach {0} ({1})', provedor, this.scrub(error)),
      );
    }
    if (!response.ok) {
      const detail = this.scrub(await response.text().catch(() => ''))
        .replace(/\s+/g, ' ')
        .slice(0, 200);
      throw new RpcError(
        FaklErrorCode.ProviderUnavailable,
        detail
          ? l10n.t(
              '{0} refused the transcription (HTTP {1}): {2}',
              provedor,
              String(response.status),
              detail,
            )
          : l10n.t('{0} refused the transcription (HTTP {1})', provedor, String(response.status)),
      );
    }
    const json = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined;
    if (typeof json?.text !== 'string') {
      throw new RpcError(
        FaklErrorCode.ProviderUnavailable,
        l10n.t('{0} replied without the transcription text', provedor),
      );
    }
    return { texto: json.text.trim() };
  }

  /** Mensagem sem o token, caso o provedor ou o fetch o repita. */
  private scrub(value: unknown): string {
    const text = value instanceof Error ? value.message : String(value);
    const token = this.options.secrets.get('voz.token');
    return token ? text.split(token).join('***') : text;
  }

  register(router: Router): void {
    router.register('voz.status', () => this.status());
    router.register('voz.configurar', (params) => {
      const p = objectParams(params);
      const modo = p.modo;
      if (modo !== null && !isVozModo(modo)) {
        throw RpcError.invalidParams(l10n.t('modo must be {0} or null', VOZ_MODOS.join(', ')));
      }
      const texto = (nome: 'modelo' | 'endpoint' | 'idioma'): string | undefined => {
        const value = p[nome];
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value !== 'string')
          throw RpcError.invalidParams(l10n.t('{0} must be text', nome));
        return value;
      };
      const modelo = texto('modelo');
      const endpoint = texto('endpoint');
      const idioma = texto('idioma');
      return this.configurar({
        modo,
        ...(modelo ? { modelo } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(idioma ? { idioma } : {}),
      });
    });
    router.register('voz.transcrever', (params) => {
      const p = objectParams(params);
      const idioma = p.idioma;
      if (idioma !== undefined && typeof idioma !== 'string') {
        throw RpcError.invalidParams(l10n.t('{0} must be text', 'idioma'));
      }
      return this.transcrever({
        audio: stringParam(p, 'audio'),
        mime: stringParam(p, 'mime'),
        ...(idioma ? { idioma } : {}),
      });
    });
  }
}
