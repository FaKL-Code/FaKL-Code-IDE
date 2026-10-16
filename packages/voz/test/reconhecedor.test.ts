import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  blobParaBase64,
  criarReconhecedor,
  suporteDeVoz,
  type ErroDeVoz,
  type EstadoDoReconhecedor,
} from '../src/reconhecedor.js';

class FalsoSpeech {
  static ultimo: FalsoSpeech | undefined;
  lang = '';
  continuous = false;
  interimResults = false;
  iniciado = false;
  abortado = false;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FalsoSpeech.ultimo = this;
  }
  start(): void {
    this.iniciado = true;
  }
  stop(): void {
    this.onend?.();
  }
  abort(): void {
    this.abortado = true;
    this.onend?.();
  }
}

function ultimoSpeech(): FalsoSpeech {
  if (!FalsoSpeech.ultimo) throw new Error('nenhum reconhecedor criado');
  return FalsoSpeech.ultimo;
}

function resultado(itens: { texto: string; final: boolean }[], resultIndex = 0): unknown {
  return {
    resultIndex,
    results: itens.map((i) => Object.assign([{ transcript: i.texto }], { isFinal: i.final })),
  };
}

function coletor() {
  const coletado = {
    parciais: [] as string[],
    finais: [] as string[],
    erros: [] as ErroDeVoz[],
    estados: [] as EstadoDoReconhecedor[],
  };
  return {
    coletado,
    callbacks: {
      onParcial: (t: string) => coletado.parciais.push(t),
      onFinal: (t: string) => coletado.finais.push(t),
      onErro: (e: ErroDeVoz) => coletado.erros.push(e),
      onEstado: (s: EstadoDoReconhecedor) => coletado.estados.push(s),
    },
  };
}

describe('suporteDeVoz', () => {
  it('detecta SpeechRecognition e a versão com prefixo', () => {
    expect(suporteDeVoz({ SpeechRecognition: FalsoSpeech })).toEqual({
      navegador: true,
      gravacao: false,
    });
    expect(suporteDeVoz({ webkitSpeechRecognition: FalsoSpeech }).navegador).toBe(true);
  });

  it('gravação exige MediaRecorder e getUserMedia', () => {
    const navigator = { mediaDevices: { getUserMedia: () => Promise.resolve({}) } };
    expect(suporteDeVoz({ MediaRecorder: vi.fn(), navigator }).gravacao).toBe(true);
    expect(suporteDeVoz({ MediaRecorder: vi.fn() }).gravacao).toBe(false);
    expect(suporteDeVoz({ navigator }).gravacao).toBe(false);
    expect(suporteDeVoz({})).toEqual({ navegador: false, gravacao: false });
  });
});

describe('criarReconhecedor: escolha do modo', () => {
  it('lança sem-suporte quando nada serve', () => {
    expect(() => criarReconhecedor({}, {})).toThrow(
      expect.objectContaining({ tipo: 'sem-suporte' }) as Error,
    );
  });

  it('prefere o navegador; gravação sem transcrever é sem-suporte', () => {
    const navigator = { mediaDevices: { getUserMedia: () => Promise.resolve({}) } };
    const amb = { SpeechRecognition: FalsoSpeech, MediaRecorder: vi.fn(), navigator };
    expect(criarReconhecedor({}, amb).modo).toBe('navegador');
    expect(() => criarReconhecedor({ modo: 'gravacao' }, amb)).toThrow(
      expect.objectContaining({ tipo: 'sem-suporte' }) as Error,
    );
    expect(
      criarReconhecedor({ modo: 'gravacao', transcrever: () => Promise.resolve('') }, amb).modo,
    ).toBe('gravacao');
  });

  it('sem Web Speech cai para gravação', () => {
    const navigator = { mediaDevices: { getUserMedia: () => Promise.resolve({}) } };
    const r = criarReconhecedor(
      { transcrever: () => Promise.resolve('') },
      { MediaRecorder: vi.fn(), navigator },
    );
    expect(r.modo).toBe('gravacao');
  });
});

describe('criarReconhecedor: modo navegador', () => {
  beforeEach(() => {
    FalsoSpeech.ultimo = undefined;
  });

  it('configura o idioma e entrega parcial e final normalizados', async () => {
    const { coletado, callbacks } = coletor();
    const r = criarReconhecedor({ ...callbacks }, { SpeechRecognition: FalsoSpeech });
    await r.iniciar();
    const rec = ultimoSpeech();
    expect(rec.lang).toBe('pt-BR');
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.iniciado).toBe(true);
    expect(r.estado).toBe('ouvindo');

    rec.onresult?.(resultado([{ texto: 'olá vírgula', final: false }]));
    rec.onresult?.(resultado([{ texto: 'olá vírgula mundo ponto final', final: true }]));
    expect(coletado.parciais[0]).toBe('olá vírgula');
    expect(coletado.finais).toEqual(['Olá, mundo.']);

    rec.onend?.();
    expect(r.estado).toBe('parado');
    expect(coletado.estados).toEqual(['ouvindo', 'parado']);
  });

  it('respeita o idioma pedido', async () => {
    const r = criarReconhecedor({ idioma: 'en-US' }, { SpeechRecognition: FalsoSpeech });
    await r.iniciar();
    expect(FalsoSpeech.ultimo?.lang).toBe('en-US');
  });

  it.each([
    ['not-allowed', 'sem-permissao'],
    ['service-not-allowed', 'sem-permissao'],
    ['no-speech', 'sem-fala'],
    ['network', 'rede'],
    ['audio-capture', 'outro'],
  ] as const)('mapeia o erro %s para %s', async (codigo, tipo) => {
    const { coletado, callbacks } = coletor();
    const r = criarReconhecedor({ ...callbacks }, { SpeechRecognition: FalsoSpeech });
    await r.iniciar();
    FalsoSpeech.ultimo?.onerror?.({ error: codigo });
    expect(coletado.erros).toHaveLength(1);
    expect(coletado.erros[0]?.tipo).toBe(tipo);
    expect(coletado.erros[0]?.mensagem.length).toBeGreaterThan(10);
    if (tipo === 'rede') expect(coletado.erros[0]?.mensagem).toMatch(/navegador/i);
  });

  it('cancelar descarta o que chegar depois e não reporta erro', async () => {
    const { coletado, callbacks } = coletor();
    const r = criarReconhecedor({ ...callbacks }, { SpeechRecognition: FalsoSpeech });
    await r.iniciar();
    const rec = ultimoSpeech();
    r.cancelar();
    rec.onresult?.(resultado([{ texto: 'tarde demais', final: true }]));
    rec.onerror?.({ error: 'aborted' });
    expect(rec.abortado).toBe(true);
    expect(coletado.finais).toEqual([]);
    expect(coletado.erros).toEqual([]);
    expect(r.estado).toBe('parado');
  });
});

class FalsoGravador {
  static ultimo: FalsoGravador | undefined;
  static tiposAceitos = ['audio/webm', 'audio/mp4'];
  static isTypeSupported(tipo: string): boolean {
    return FalsoGravador.tiposAceitos.includes(tipo);
  }
  mimeType: string;
  state = 'inactive';
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: unknown,
    readonly opcoes?: { mimeType?: string },
  ) {
    this.mimeType = opcoes?.mimeType ?? '';
    FalsoGravador.ultimo = this;
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['áudio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

describe('criarReconhecedor: modo gravação', () => {
  const trilha = { parou: false, stop: () => void (trilha.parou = true) };
  let getUserMedia: ReturnType<typeof vi.fn>;
  let ambiente: object;

  beforeEach(() => {
    vi.useFakeTimers();
    trilha.parou = false;
    FalsoGravador.ultimo = undefined;
    getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [trilha] }));
    ambiente = { MediaRecorder: FalsoGravador, navigator: { mediaDevices: { getUserMedia } } };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grava, para as trilhas, transcreve e entrega o texto normalizado', async () => {
    const { coletado, callbacks } = coletor();
    const transcrever = vi.fn((audio: Blob) => Promise.resolve(`olá vírgula ${audio.type}`));
    const r = criarReconhecedor({ modo: 'gravacao', transcrever, ...callbacks }, ambiente);
    await r.iniciar();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FalsoGravador.ultimo?.opcoes?.mimeType).toBe('audio/webm');
    expect(r.estado).toBe('ouvindo');

    r.parar();
    await vi.advanceTimersByTimeAsync(0);
    expect(trilha.parou).toBe(true);
    expect(transcrever).toHaveBeenCalledTimes(1);
    expect(coletado.finais).toEqual(['Olá, audio/webm']);
    expect(coletado.estados).toEqual(['ouvindo', 'transcrevendo', 'parado']);
    expect(r.estado).toBe('parado');
  });

  it('escolhe o primeiro tipo aceito, na ordem de preferência', async () => {
    FalsoGravador.tiposAceitos = ['audio/mp4', 'audio/ogg;codecs=opus'];
    const r = criarReconhecedor(
      { modo: 'gravacao', transcrever: () => Promise.resolve('x') },
      ambiente,
    );
    await r.iniciar();
    expect(FalsoGravador.ultimo?.opcoes?.mimeType).toBe('audio/mp4');
    FalsoGravador.tiposAceitos = ['audio/webm', 'audio/mp4'];
  });

  it('transcrição vazia vira erro sem-fala', async () => {
    const { coletado, callbacks } = coletor();
    const r = criarReconhecedor(
      { modo: 'gravacao', transcrever: () => Promise.resolve('  '), ...callbacks },
      ambiente,
    );
    await r.iniciar();
    r.parar();
    await vi.advanceTimersByTimeAsync(0);
    expect(coletado.finais).toEqual([]);
    expect(coletado.erros.map((e) => e.tipo)).toEqual(['sem-fala']);
    expect(r.estado).toBe('parado');
  });

  it('erro do transcrever vira erro outro com a mensagem', async () => {
    const { coletado, callbacks } = coletor();
    const r = criarReconhecedor(
      {
        modo: 'gravacao',
        transcrever: () => Promise.reject(new Error('serviço fora')),
        ...callbacks,
      },
      ambiente,
    );
    await r.iniciar();
    r.parar();
    await vi.advanceTimersByTimeAsync(0);
    expect(coletado.erros).toHaveLength(1);
    expect(coletado.erros[0]?.tipo).toBe('outro');
    expect(coletado.erros[0]?.mensagem).toContain('serviço fora');
    expect(r.estado).toBe('parado');
  });

  it('permissão negada do microfone vira sem-permissao', async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    const { coletado, callbacks } = coletor();
    const r = criarReconhecedor(
      { modo: 'gravacao', transcrever: () => Promise.resolve('x'), ...callbacks },
      ambiente,
    );
    await r.iniciar();
    expect(coletado.erros.map((e) => e.tipo)).toEqual(['sem-permissao']);
    expect(r.estado).toBe('parado');
  });

  it('para sozinho no limite de tempo', async () => {
    const { coletado, callbacks } = coletor();
    const r = criarReconhecedor(
      {
        modo: 'gravacao',
        limiteMs: 5000,
        transcrever: () => Promise.resolve('fim'),
        ...callbacks,
      },
      ambiente,
    );
    await r.iniciar();
    await vi.advanceTimersByTimeAsync(4999);
    expect(r.estado).toBe('ouvindo');
    await vi.advanceTimersByTimeAsync(1);
    expect(coletado.finais).toEqual(['Fim']);
  });

  it('cancelar descarta o áudio sem transcrever', async () => {
    const transcrever = vi.fn(() => Promise.resolve('x'));
    const { coletado, callbacks } = coletor();
    const r = criarReconhecedor({ modo: 'gravacao', transcrever, ...callbacks }, ambiente);
    await r.iniciar();
    r.cancelar();
    await vi.advanceTimersByTimeAsync(0);
    expect(transcrever).not.toHaveBeenCalled();
    expect(trilha.parou).toBe(true);
    expect(coletado.finais).toEqual([]);
    expect(r.estado).toBe('parado');
  });
});

describe('criarReconhecedor: aquisição do microfone', () => {
  it('iniciar de novo enquanto aguarda a permissão não abre um segundo fluxo', async () => {
    const trilha = { stop: vi.fn() };
    let liberar: (fluxo: unknown) => void = () => undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          liberar = resolve;
        }),
    );
    const ambiente = {
      MediaRecorder: FalsoGravador,
      navigator: { mediaDevices: { getUserMedia } },
    };
    const r = criarReconhecedor(
      { modo: 'gravacao', transcrever: () => Promise.resolve('x') },
      ambiente,
    );
    const primeira = r.iniciar();
    const segunda = r.iniciar();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    r.cancelar();
    liberar({ getTracks: () => [trilha] });
    await Promise.all([primeira, segunda]);
    expect(trilha.stop).toHaveBeenCalledTimes(1);
    expect(r.estado).toBe('parado');
  });
});

describe('blobParaBase64', () => {
  it('codifica sem o prefixo data:', async () => {
    expect(await blobParaBase64(new Blob(['olá']))).toBe(Buffer.from('olá').toString('base64'));
  });

  it('aguenta blobs grandes (em blocos)', async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(await blobParaBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString('base64'));
  });
});
