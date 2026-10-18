import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exportKeyPair, generateKeyPair } from '@fakl/remote';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventBus } from '../src/events/bus.js';
import { RemoteGateway } from '../src/remote/gateway.js';
import {
  newIdentityKey,
  openIdentity,
  parseIdentityKey,
  readIdentityFile,
  sealIdentity,
} from '../src/remote/identity-store.js';
import { Router } from '../src/rpc/router.js';
import { RpcServer } from '../src/rpc/server.js';

let dir: string;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fakl-identity-'));
  logs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function gateway(key: { value: string | undefined }, keyWaitMs = 20): RemoteGateway {
  const server = new RpcServer({ router: new Router(), token: 't', coreVersion: '0' });
  return new RemoteGateway({
    bus: new EventBus(),
    server,
    dir,
    config: () => undefined,
    log: (m) => logs.push(m),
    identityKey: () => key.value,
    keyWaitMs,
  });
}

/** Chave de 32 bytes já decodificada; falha o teste se a chave for inválida. */
function bytes(text: string | undefined): Buffer {
  const key = parseIdentityKey(text);
  if (!key) throw new Error('chave inválida');
  return key;
}

const file = (): string => join(dir, 'identity.json');
const read = (): Promise<string> => readFile(file(), 'utf8');

/** Identidade antiga, em texto, como a versão anterior gravava. */
async function writePlain(): Promise<{ segredo: string; chave: unknown }> {
  const identity = {
    segredo: 'segredo-antigo-do-aparelho',
    chave: await exportKeyPair(await generateKeyPair(true)),
  };
  await writeFile(file(), JSON.stringify(identity), 'utf8');
  return identity;
}

describe('identity-store', () => {
  it('ida e volta cifrada, sem o texto em claro', () => {
    const key = bytes(newIdentityKey());
    expect(key).toHaveLength(32);
    const identity = { segredo: 'abc-segredo', chave: { kty: 'EC', d: 'privada' } };
    const sealed = sealIdentity(identity, key);
    expect(JSON.stringify(sealed)).not.toContain('abc-segredo');
    expect(JSON.stringify(sealed)).not.toContain('privada');
    expect(openIdentity(sealed, key)).toEqual(identity);
  });

  it('chave errada ou conteúdo alterado não abre', () => {
    const key = bytes(newIdentityKey());
    const sealed = sealIdentity({ segredo: 's', chave: {} }, key);
    expect(openIdentity(sealed, bytes(newIdentityKey()))).toBeUndefined();
    const tampered = { ...sealed, dados: Buffer.from('outro').toString('base64url') };
    expect(openIdentity(tampered, key)).toBeUndefined();
  });

  it('só aceita chave de exatamente 32 bytes', () => {
    expect(parseIdentityKey(undefined)).toBeUndefined();
    expect(parseIdentityKey('curta')).toBeUndefined();
    expect(parseIdentityKey(Buffer.alloc(31).toString('base64url'))).toBeUndefined();
    expect(parseIdentityKey(Buffer.alloc(32).toString('base64url'))).toHaveLength(32);
  });
});

describe('identidade do gateway', () => {
  it('cria a identidade já cifrada quando a IDE entregou a chave', async () => {
    const key = { value: newIdentityKey() };
    await gateway(key).load();
    const text = await read();
    expect(text).toContain('aes-256-gcm');
    expect(text).not.toContain('"segredo"');
    expect((await readIdentityFile(file())).kind).toBe('cifrado');
  });

  it('migra o arquivo em texto, mantém a identidade e os aparelhos pareados', async () => {
    const plain = await writePlain();
    const devices = [{ id: 'a1', nome: 'Celular', chave: 'k', escopos: ['ver'], criadoEm: 'x' }];
    await writeFile(join(dir, 'devices.json'), JSON.stringify(devices), 'utf8');
    const key = { value: newIdentityKey() };

    const first = gateway(key);
    await first.load();
    expect((await readIdentityFile(file())).kind).toBe('cifrado');
    expect(await read()).not.toContain(plain.segredo);
    expect(first.status().aparelhos).toBe(1);
    expect(logs.join('\n')).toMatch(/migrada/);

    // O mesmo segredo volta ao abrir de novo: o id no relay não muda.
    const again = await readIdentityFile(file());
    if (again.kind !== 'cifrado') throw new Error('esperava arquivo cifrado');
    expect(openIdentity(again.sealed, bytes(key.value))?.segredo).toBe(plain.segredo);
    const second = gateway(key);
    await second.load();
    expect(second.status().aparelhos).toBe(1);
  });

  it('chave errada: erro claro e o arquivo fica como estava', async () => {
    const key = { value: newIdentityKey() };
    await gateway(key).load();
    const before = await read();
    const wrong = { value: newIdentityKey() };
    await expect(gateway(wrong).load()).rejects.toThrow(/chave errada/);
    expect(await read()).toBe(before);
  });

  it('arquivo corrompido: erro, sem criar outra identidade por cima', async () => {
    await writeFile(file(), '{ isso nao e json', 'utf8');
    const key = { value: newIdentityKey() };
    await expect(gateway(key).load()).rejects.toThrow(/não pode ser lido/);
    expect(await read()).toBe('{ isso nao e json');
  });

  it('arquivo cifrado sem chave: não abre; a chave que chega depois destrava', async () => {
    const key = { value: newIdentityKey() };
    await gateway(key).load();
    const semChave: { value: string | undefined } = { value: undefined };
    const g = gateway(semChave);
    await expect(g.start()).rejects.toThrow(/ainda não entregou a chave/);
    expect(g.status().estado).toBe('erro');
    semChave.value = key.value;
    g.keyChanged();
    await expect.poll(() => g.status().estado, { timeout: 2_000 }).toBe('desligado');
    await expect(g.load()).resolves.toBeUndefined();
  });

  it('sem a IDE (sem chave): segue em texto, com aviso, sem derrubar o gateway', async () => {
    const plain = await writePlain();
    const g = gateway({ value: undefined });
    await g.load();
    expect(JSON.parse(await read())).toMatchObject({ segredo: plain.segredo });
    expect(logs.join('\n')).toMatch(/em texto/);
  });

  it('a chave chega depois do Core abrir: migra o arquivo em texto', async () => {
    const plain = await writePlain();
    const key: { value: string | undefined } = { value: undefined };
    const g = gateway(key);
    await g.load();
    expect((await readIdentityFile(file())).kind).toBe('claro');
    key.value = newIdentityKey();
    g.keyChanged();
    await expect
      .poll(async () => (await readIdentityFile(file())).kind, { timeout: 2_000 })
      .toBe('cifrado');
    expect(await read()).not.toContain(plain.segredo);
  });

  it('espera a chave que chega logo após a abertura', async () => {
    const key: { value: string | undefined } = { value: undefined };
    const g = gateway(key, 2_000);
    const loading = g.load();
    setTimeout(() => {
      key.value = newIdentityKey();
      g.keyChanged();
    }, 30);
    await loading;
    expect((await readIdentityFile(file())).kind).toBe('cifrado');
  });
});
