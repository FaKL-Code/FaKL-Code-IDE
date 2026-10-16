import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ChannelError,
  decodePairing,
  deriveChannel,
  encodePairing,
  exportKeyPair,
  fromBase64Url,
  generateKeyPair,
  importKeyPair,
  machineIdFromSecret,
  methodsForScopes,
  pairingUrl,
  parseFrame,
  relaySocketUrl,
  RemoteError,
  RemoteSession,
  toBase64Url,
  type Box,
  type HandshakeMode,
  type KeyPair,
} from '../src/index.js';

async function handshake(
  mode: HandshakeMode,
  codes: { device?: string; core?: string } = {},
  coreStatic?: KeyPair,
): Promise<{
  device: Awaited<ReturnType<typeof deriveChannel>>;
  core: Awaited<ReturnType<typeof deriveChannel>>;
}> {
  const deviceStatic = await generateKeyPair();
  const deviceEph = await generateKeyPair();
  const core = coreStatic ?? (await generateKeyPair());
  const coreEph = await generateKeyPair();
  return {
    device: await deriveChannel({
      role: 'aparelho',
      mode,
      mine: deviceStatic,
      ephemeral: deviceEph,
      peerStatic: core.raw,
      peerEphemeral: coreEph.raw,
      ...(codes.device ? { code: codes.device } : {}),
    }),
    core: await deriveChannel({
      role: 'core',
      mode,
      mine: core,
      ephemeral: coreEph,
      peerStatic: deviceStatic.raw,
      peerEphemeral: deviceEph.raw,
      ...(codes.core ? { code: codes.core } : {}),
    }),
  };
}

const box = (text: string): Box => parseFrame(text) as Box;

describe('canal cifrado', () => {
  it('as duas pontas conversam nos dois sentidos', async () => {
    const { device, core } = await handshake('entrar');
    expect(await core.open(box(await device.seal({ oi: 'core' })))).toEqual({ oi: 'core' });
    expect(await device.open(box(await core.seal({ oi: 'celular' })))).toEqual({ oi: 'celular' });
    expect(await core.open(box(await device.seal([1, 2])))).toEqual([1, 2]);
  });

  it('pareia só com o código certo', async () => {
    const ok = await handshake('parear', { device: 'abc', core: 'abc' });
    expect(await ok.core.open(box(await ok.device.seal('x')))).toBe('x');
    const wrong = await handshake('parear', { device: 'abd', core: 'abc' });
    await expect(wrong.core.open(box(await wrong.device.seal('x')))).rejects.toBeInstanceOf(
      ChannelError,
    );
  });

  it('recusa repetição, ordem trocada e adulteração', async () => {
    const { device, core } = await handshake('entrar');
    const first = await device.seal(1);
    const second = await device.seal(2);
    await expect(core.open(box(second))).rejects.toThrow(/fora de ordem/);

    const again = await handshake('entrar');
    const sealed = box(await again.device.seal('a'));
    const bytes = fromBase64Url(sealed.c);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(again.core.open({ ...sealed, c: toBase64Url(bytes) })).rejects.toThrow(/abrir/);
    expect(first).toBeTruthy();
  });

  it('um impostor sem a chave do Core não abre nada', async () => {
    const real = await generateKeyPair();
    const fake = await generateKeyPair();
    const deviceStatic = await generateKeyPair();
    const deviceEph = await generateKeyPair();
    const coreEph = await generateKeyPair();
    // O aparelho acha que fala com `real`, mas quem responde tem `fake`.
    const device = await deriveChannel({
      role: 'aparelho',
      mode: 'entrar',
      mine: deviceStatic,
      ephemeral: deviceEph,
      peerStatic: real.raw,
      peerEphemeral: coreEph.raw,
    });
    const impostor = await deriveChannel({
      role: 'core',
      mode: 'entrar',
      mine: fake,
      ephemeral: coreEph,
      peerStatic: deviceStatic.raw,
      peerEphemeral: deviceEph.raw,
    });
    await expect(device.open(box(await impostor.seal('oi')))).rejects.toBeInstanceOf(ChannelError);
  });

  it('a chave fixa do Core sobrevive a um arquivo', async () => {
    const original = await generateKeyPair(true);
    const restored = await importKeyPair(await exportKeyPair(original));
    expect(restored.raw).toEqual(original.raw);
    const { device, core } = await handshake('entrar', {}, restored);
    expect(await core.open(box(await device.seal('ok')))).toBe('ok');
  });
});

describe('pareamento e relay', () => {
  it('codifica o QR num link para o PWA', () => {
    const payload = {
      v: 1,
      r: 'https://relay.exemplo.com/',
      m: 'm',
      k: 'k',
      c: 'c',
      n: 'PC',
    } as const;
    const url = pairingUrl(payload);
    expect(url.startsWith('https://relay.exemplo.com/#p=')).toBe(true);
    expect(decodePairing(url.split('#p=')[1] ?? '')).toEqual(payload);
    expect(decodePairing(encodePairing(payload))).toEqual(payload);
    expect(() => decodePairing(toBase64Url(new TextEncoder().encode('{}')))).toThrow(/inválido/);
  });

  it('monta o endereço WebSocket', () => {
    expect(relaySocketUrl('https://r.exemplo.com', '/core')).toBe('wss://r.exemplo.com/core');
    expect(relaySocketUrl('http://127.0.0.1:8080/fakl/', '/device', '?m=x')).toBe(
      'ws://127.0.0.1:8080/fakl/device?m=x',
    );
  });

  it('o id da máquina vem do segredo', async () => {
    const id = await machineIdFromSecret('segredo');
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await machineIdFromSecret('segredo')).toBe(id);
    expect(await machineIdFromSecret('outro')).not.toBe(id);
  });

  it('escopos viram métodos', () => {
    const ver = methodsForScopes(['ver']);
    expect(ver.has('runs.get')).toBe(true);
    expect(ver.has('runs.decide')).toBe(false);
    expect(methodsForScopes(['ver', 'decidir']).has('runs.decide')).toBe(true);
    expect(methodsForScopes(['comandar']).has('tasks.create')).toBe(true);
    expect(methodsForScopes(['comandar']).has('agents.start')).toBe(true);
    expect(ver.has('agents.transcript')).toBe(true);
    expect(ver.has('agents.start')).toBe(false);
    expect(ver.has('claude.accounts.list')).toBe(true);
    expect(ver.has('claude.accounts.setActive')).toBe(false);
    expect(methodsForScopes(['comandar']).has('claude.accounts.setActive')).toBe(true);
    // Login e saída pedem o terminal da IDE: não vão para o celular.
    expect(methodsForScopes(['ver', 'comandar']).has('claude.accounts.logout')).toBe(false);
    expect(methodsForScopes(['ver', 'comandar']).has('claude.accounts.prepare')).toBe(false);
  });
});

describe('mensagens do aparelho', () => {
  afterEach(() => {
    useLocale('en');
  });

  /** WebSocket que falha ao abrir, como quando o relay não acha a máquina. */
  function failing(): WebSocket {
    return {
      addEventListener(type: string, listener: () => void) {
        if (type === 'error') queueMicrotask(listener);
      },
    } as unknown as WebSocket;
  }

  async function offline(): Promise<RemoteError> {
    const keys = await generateKeyPair();
    const target = { relay: 'https://relay.test', machine: 'm', coreKey: 'x' };
    return RemoteSession.connect(target, keys, { factory: failing }).then(
      () => {
        throw new Error('deveria falhar');
      },
      (error: unknown) => error as RemoteError,
    );
  }

  it('explica o motivo no idioma da interface', async () => {
    useLocale('en');
    const error = await offline();
    expect(error).toBeInstanceOf(RemoteError);
    expect(error.motivo).toBe('offline');
    expect(error.message).toBe(
      'The IDE is not open on this machine (or remote access is turned off).',
    );
    useLocale('pt-br');
    expect((await offline()).message).toBe(
      'A IDE não está aberta nesta máquina (ou o acesso remoto está desligado).',
    );
    expect(() => decodePairing(toBase64Url(new TextEncoder().encode('{}')))).toThrow(
      'QR de pareamento inválido',
    );
  });
});
