import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigStore,
  parseConfig,
  Router,
  VozService,
  type VozConfig,
  type VozServerConfig,
} from '../src/index.js';
import { SecretVault } from '../src/secrets.js';

const CONFIG: VozServerConfig = {
  modo: 'openai',
  modelo: 'gpt-4o-mini-transcribe',
  endpoint: 'https://api.openai.com/v1',
  idioma: 'pt',
  limiteMb: 20,
};
const AUDIO = Buffer.from('audio-de-mentira').toString('base64');

interface Call {
  url: string;
  headers: Record<string, string>;
  form: FormData;
}

function setup(config: VozConfig | undefined, token?: string, reply?: () => Response) {
  const secrets = new SecretVault();
  if (token) secrets.set('voz.token', token);
  const calls: Call[] = [];
  const fetchFake = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      form: init.body as FormData,
    });
    return Promise.resolve(reply ? reply() : Response.json({ text: '  abrir o projeto  ' }));
  }) as unknown as typeof fetch;
  const service = new VozService({ config: () => config, secrets, fetch: fetchFake });
  return { service, calls };
}

describe('voz.status', () => {
  it('começa desligada, sem modo', () => {
    const status = setup(undefined).service.status();
    expect(status.configurado).toBe(false);
    expect(status.modo).toBeUndefined();
    expect(status.motivo).toMatch(/desligada.*navegador, openai, groq, local/);
  });

  it('avisa quando falta o token', () => {
    const status = setup(CONFIG).service.status();
    expect(status).toMatchObject({ configurado: false, modo: 'openai', provedor: 'openai' });
    expect(status.motivo).toContain('voz.token');
  });

  it('fica pronto com token, ou sem ele no provedor local', () => {
    expect(setup(CONFIG, 'sk-x').service.status()).toEqual({
      configurado: true,
      modo: 'openai',
      provedor: 'openai',
      modelo: 'gpt-4o-mini-transcribe',
      endpoint: 'https://api.openai.com/v1',
    });
    const local = { ...CONFIG, modo: 'local' as const, modelo: 'whisper-1' };
    expect(setup(local).service.status().configurado).toBe(true);
  });

  it('modo navegador fica pronto sem chave e sem transcrição no Core', async () => {
    const { service, calls } = setup({ modo: 'navegador', idioma: 'pt' });
    expect(service.status()).toEqual({ configurado: true, modo: 'navegador' });
    await expect(service.transcrever({ audio: AUDIO, mime: 'audio/webm' })).rejects.toThrow(
      /modo navegador/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('voz.transcrever', () => {
  it('envia o áudio ao provedor e devolve o texto sem espaços', async () => {
    const { service, calls } = setup(CONFIG, 'sk-x');
    const result = await service.transcrever({
      audio: AUDIO,
      mime: 'audio/webm;codecs=opus',
      idioma: 'pt-BR',
    });
    expect(result).toEqual({ texto: 'abrir o projeto' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(call?.headers).toEqual({ authorization: 'Bearer sk-x' });
    expect(call?.form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(call?.form.get('language')).toBe('pt');
    expect(call?.form.get('response_format')).toBe('json');
    const file = call?.form.get('file') as File;
    expect(file.name).toBe('fala.webm');
    expect(file.type).toBe('audio/webm;codecs=opus');
    expect(file.size).toBe(Buffer.from(AUDIO, 'base64').length);
  });

  it('usa o idioma do config, a extensão do mime e dispensa token no local', async () => {
    const local = { ...CONFIG, modo: 'local' as const, endpoint: 'http://127.0.0.1:8000/v1' };
    const { service, calls } = setup({ ...local, idioma: 'en' });
    await service.transcrever({ audio: AUDIO, mime: 'audio/mp4' });
    expect(calls[0]?.headers).toEqual({});
    expect(calls[0]?.form.get('language')).toBe('en');
    expect((calls[0]?.form.get('file') as File).name).toBe('fala.m4a');
  });

  it('traduz erro HTTP sem vazar o token', async () => {
    const { service } = setup(CONFIG, 'sk-segredo', () =>
      Response.json({ error: { message: 'chave sk-segredo inválida' } }, { status: 401 }),
    );
    const attempt = service.transcrever({ audio: AUDIO, mime: 'audio/webm' });
    await expect(attempt).rejects.toThrow(/HTTP 401.*inválida/);
    await expect(attempt).rejects.not.toThrow(/sk-segredo/);
  });

  it('recusa base64 inválido, mime estranho e áudio acima do limite', async () => {
    const { service, calls } = setup({ ...CONFIG, limiteMb: 0.0001 }, 'sk-x');
    await expect(service.transcrever({ audio: '***', mime: 'audio/webm' })).rejects.toThrow(
      /base64/,
    );
    await expect(service.transcrever({ audio: AUDIO, mime: 'text/plain' })).rejects.toThrow(/mime/);
    const big = Buffer.alloc(200).toString('base64');
    await expect(service.transcrever({ audio: big, mime: 'audio/webm' })).rejects.toThrow(
      /grande demais/,
    );
    expect(calls).toHaveLength(0);
  });

  it('recusa quando a voz não está configurada', async () => {
    await expect(
      setup(CONFIG).service.transcrever({ audio: AUDIO, mime: 'audio/webm' }),
    ).rejects.toThrow(/não configurada/);
  });

  it('registra os métodos no router', async () => {
    const { service } = setup(CONFIG, 'sk-x');
    const router = new Router();
    service.register(router);
    const context = { connectionId: 'c', notify: () => undefined, onClose: () => () => undefined };
    expect(await router.dispatch('voz.status', undefined, context)).toMatchObject({
      configurado: true,
    });
    expect(
      await router.dispatch('voz.transcrever', { audio: AUDIO, mime: 'audio/webm' }, context),
    ).toEqual({ texto: 'abrir o projeto' });
    await expect(router.dispatch('voz.transcrever', { audio: AUDIO }, context)).rejects.toThrow();
    // Sem onde gravar, voz.configurar recusa.
    await expect(router.dispatch('voz.configurar', { modo: 'navegador' }, context)).rejects.toThrow(
      /indisponível/,
    );
  });
});

describe('voz.configurar', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-voz-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const context = { connectionId: 'c', notify: () => undefined, onClose: () => () => undefined };

  async function service() {
    const store = new ConfigStore({ home });
    await store.load();
    const secrets = new SecretVault();
    const voz = new VozService({
      config: () => store.config.voz,
      save: (change) => store.setVoz(change),
      secrets,
    });
    const router = new Router();
    voz.register(router);
    const call = (params: unknown) => router.dispatch('voz.configurar', params, context);
    return { store, secrets, call };
  }

  it('escolhe o modo, troca e desliga, gravando voz: no config.yaml', async () => {
    const { store, secrets, call } = await service();
    expect(store.config.voz).toBeUndefined();

    expect(await call({ modo: 'navegador' })).toEqual({ configurado: true, modo: 'navegador' });
    expect(store.config.voz).toEqual({ modo: 'navegador', idioma: 'pt' });
    expect(await readFile(store.configFile, 'utf8')).toMatch(/^voz:\n {2}modo: navegador$/m);

    expect(await call({ modo: 'groq' })).toMatchObject({ configurado: false, modo: 'groq' });
    secrets.set('voz.token', 'gsk-x');
    expect(store.config.voz).toMatchObject({ modo: 'groq', modelo: 'whisper-large-v3-turbo' });

    expect(
      await call({ modo: 'local', endpoint: 'http://127.0.0.1:9000/v1/', modelo: 'small' }),
    ).toMatchObject({ configurado: true, modo: 'local', endpoint: 'http://127.0.0.1:9000/v1' });
    const yaml = await readFile(store.configFile, 'utf8');
    expect(yaml).toContain('endpoint: http://127.0.0.1:9000/v1');
    expect(yaml).not.toContain('gsk-x');

    // Mesmo modo de novo mantém endereço e modelo.
    await call({ modo: 'local' });
    expect(store.config.voz).toMatchObject({
      endpoint: 'http://127.0.0.1:9000/v1',
      modelo: 'small',
    });
    // Outro provedor volta aos padrões dele.
    await call({ modo: 'openai' });
    expect(store.config.voz).toMatchObject({
      modo: 'openai',
      endpoint: 'https://api.openai.com/v1',
      modelo: 'gpt-4o-mini-transcribe',
    });

    expect(await call({ modo: null })).toMatchObject({ configurado: false });
    expect(store.config.voz).toBeUndefined();
    expect(await readFile(store.configFile, 'utf8')).not.toMatch(/^voz:/m);
  });

  it('recusa modo e endereço inválidos sem mexer no arquivo', async () => {
    const { store, call } = await service();
    const before = await readFile(store.configFile, 'utf8');
    await expect(call({ modo: 'azure' })).rejects.toThrow(/modo deve ser/);
    await expect(call({ modo: 'local', endpoint: 'ftp://x' })).rejects.toThrow(/http/);
    await expect(call({ modo: 'local', modelo: 3 })).rejects.toThrow(/texto/);
    expect(await readFile(store.configFile, 'utf8')).toBe(before);
  });
});

describe('config voz', () => {
  it('aplica os padrões do provedor', () => {
    expect(parseConfig({ voz: { modo: 'groq' } }, 'c').voz).toEqual({
      modo: 'groq',
      modelo: 'whisper-large-v3-turbo',
      endpoint: 'https://api.groq.com/openai/v1',
      idioma: 'pt',
      limiteMb: 20,
    });
    expect(
      parseConfig(
        { voz: { modo: 'local', modelo: 'm', endpoint: 'http://x:1/v1/', limiteMb: 5 } },
        'c',
      ).voz,
    ).toMatchObject({ modelo: 'm', endpoint: 'http://x:1/v1', limiteMb: 5 });
    expect(parseConfig({}, 'c').voz).toBeUndefined();
    expect(parseConfig({ voz: { modo: 'navegador', modelo: 'ignorado' } }, 'c').voz).toEqual({
      modo: 'navegador',
      idioma: 'pt',
    });
  });

  it('aceita provedor, o nome antigo de modo', () => {
    const voz: VozConfig | undefined = parseConfig({ voz: { provedor: 'openai' } }, 'c').voz;
    expect(voz).toMatchObject({ modo: 'openai', modelo: 'gpt-4o-mini-transcribe' });
  });

  it('recusa valores inválidos', () => {
    expect(() => parseConfig({ voz: { modo: 'azure' } }, 'c')).toThrow(
      /navegador, openai, groq, local/,
    );
    expect(() => parseConfig({ voz: {} }, 'c')).toThrow(/modo/);
    expect(() => parseConfig({ voz: { modo: 'local', endpoint: 'ftp://x' } }, 'c')).toThrow(/http/);
    expect(() => parseConfig({ voz: { modo: 'local', limiteMb: 0 } }, 'c')).toThrow(/limiteMb/);
    expect(() => parseConfig({ voz: 'openai' }, 'c')).toThrow(/objeto/);
  });
});
