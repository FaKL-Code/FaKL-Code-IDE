import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoreClient, createCore, createSessionToken, type Core } from '@fakl/core';
import type {
  EventNotificationParams,
  FaklEvent,
  RemoteDeviceEventData,
  RemoteDeviceInfo,
  RemotePairingInfo,
  RemoteStatus,
  RemoteTestResult,
} from '@fakl/protocol';
import {
  decodePairing,
  generateKeyPair,
  pairDevice,
  RemoteError,
  RemoteRpcError,
  RemoteSession,
  type DeviceTarget,
  type PushMessage,
  type PushSubscriptionData,
} from '@fakl/remote';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRelay, type Relay } from '../src/index.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('tempo esgotado');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function socketPath(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\fakl-relay-${randomBytes(6).toString('hex')}`
    : join(dir, 'core.sock');
}

describe('controle remoto ponta a ponta', () => {
  let dir: string;
  let server: Server;
  let relay: Relay;
  let relayUrl: string;
  let core: Core;
  let ide: CoreClient;
  const events: FaklEvent[] = [];
  const pushes: { sub: PushSubscriptionData; message: PushMessage }[] = [];

  const startCore = async (extra = ''): Promise<void> => {
    const home = join(dir, 'home');
    await mkdir(join(home, '.fakl'), { recursive: true });
    await writeFile(
      join(home, '.fakl', 'config.yaml'),
      `remoto:\n  relay: ${relayUrl}\n  nome: PC de teste\n${extra}`,
    );
    const token = createSessionToken();
    const path = socketPath(dir);
    core = createCore({
      socketPath: path,
      token,
      configHome: home,
      agents: { home, profiles: [] },
    });
    await core.start();
    ide = await CoreClient.connect(path, token, 'test');
    ide.onNotification((_method, params) => {
      events.push((params as EventNotificationParams).event);
    });
    await ide.request('events.subscribe', { topics: ['remote.*'] });
  };

  const enable = async (): Promise<void> => {
    await ide.request('remote.enable');
    await waitFor(() => relay.machines.size === 1);
    await waitFor(() => core.remote?.status().estado === 'ligado');
  };

  const pair = async (
    nome = 'Celular',
  ): Promise<{
    target: DeviceTarget;
    keys: Awaited<ReturnType<typeof generateKeyPair>>;
    id: string;
  }> => {
    const info = await ide.request<RemotePairingInfo>('remote.pair.begin');
    const payload = decodePairing(info.url.split('#p=')[1] ?? '');
    const target = { relay: payload.r, machine: payload.m, coreKey: payload.k };
    const keys = await generateKeyPair();
    const paired = pairDevice(target, keys, payload.c, nome);
    await waitFor(() =>
      events.some(
        (e) => e.topic === 'remote.device' && (e.data as RemoteDeviceEventData).tipo === 'pedido',
      ),
    );
    const request = events.find((e) => e.topic === 'remote.device')?.data as {
      pairingId: string;
      nome: string;
    };
    expect(request.nome).toBe(nome);
    await ide.request('remote.pair.confirm', { pairingId: request.pairingId, aceitar: true });
    const result = await paired;
    events.length = 0;
    return { target, keys, id: result.id };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-remote-'));
    events.length = 0;
    pushes.length = 0;
    server = createServer();
    relay = createRelay({
      server,
      vapidPublicKey: 'chave-vapid',
      push: (sub, message) => {
        pushes.push({ sub, message });
        return Promise.resolve(201);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    relayUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    ide.close();
    await core.stop();
    await relay.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it('pareia por QR, usa a API pelos escopos e revoga na hora', async () => {
    await startCore();
    expect(core.remote?.status()).toMatchObject({ ligado: false, estado: 'desligado' });
    await enable();
    const { target, keys, id } = await pair();

    const session = await RemoteSession.connect(target, keys);
    expect(await session.request('tasks.list')).toEqual([]);
    await expect(session.request('remote.enable')).rejects.toBeInstanceOf(RemoteRpcError);
    await expect(session.request('secrets.set', {})).rejects.toThrow(/not allowed|não é permitido/);
    // Abrir uma conversa é do escopo comandar: passa do filtro e esbarra na validação.
    await expect(session.request('agents.start', {})).rejects.toThrow(/cwd/);

    const devices = await ide.request<RemoteDeviceInfo[]>('remote.devices.list');
    expect(devices).toMatchObject([
      { id, nome: 'Celular', escopos: ['ver', 'decidir', 'comandar'], conectado: true },
    ]);

    // Notificações push mínimas para decisões.
    await session.request('remote.push.subscribe', {
      sub: { endpoint: 'https://push.exemplo.com/x', keys: { p256dh: 'p', auth: 'a' } },
    });
    core.bus.publish('run.decision', 'r1', { pergunta: 'segredo da tarefa' });
    await waitFor(() => pushes.length === 1);
    expect(pushes[0]?.message.texto).not.toContain('segredo');
    expect(pushes[0]?.sub.endpoint).toBe('https://push.exemplo.com/x');

    let closed: RemoteError | undefined;
    session.onClose((error) => (closed = error));
    await ide.request('remote.devices.revoke', { id });
    await waitFor(() => closed !== undefined);
    await expect(RemoteSession.connect(target, keys)).rejects.toMatchObject({
      motivo: 'desconhecido',
    });
  }, 30_000);

  it('o código do QR é de uso único e precisa estar certo', async () => {
    await startCore();
    await enable();
    const info = await ide.request<RemotePairingInfo>('remote.pair.begin');
    const payload = decodePairing(info.url.split('#p=')[1] ?? '');
    const target = { relay: payload.r, machine: payload.m, coreKey: payload.k };

    await expect(
      pairDevice(target, await generateKeyPair(), 'chute', 'Intruso'),
    ).rejects.toMatchObject({ motivo: 'codigo' });

    const keys = await generateKeyPair();
    const paired = pairDevice(target, keys, payload.c, 'Celular');
    await waitFor(() => events.some((e) => e.topic === 'remote.device'));
    const request = events.find((e) => e.topic === 'remote.device')?.data as { pairingId: string };
    await ide.request('remote.pair.confirm', { pairingId: request.pairingId, aceitar: false });
    await expect(paired).rejects.toMatchObject({ motivo: 'recusado' });
    await expect(pairDevice(target, keys, payload.c, 'Celular')).rejects.toMatchObject({
      motivo: 'codigo',
    });
    expect(await ide.request('remote.devices.list')).toEqual([]);
  }, 30_000);

  it('um aparelho desconhecido ou uma máquina offline não entram', async () => {
    await startCore();
    await enable();
    const info = await ide.request<RemotePairingInfo>('remote.pair.begin');
    const payload = decodePairing(info.url.split('#p=')[1] ?? '');
    const target = { relay: payload.r, machine: payload.m, coreKey: payload.k };
    await expect(RemoteSession.connect(target, await generateKeyPair())).rejects.toMatchObject({
      motivo: 'desconhecido',
    });
    await expect(
      RemoteSession.connect({ ...target, machine: 'A'.repeat(22) }, await generateKeyPair()),
    ).rejects.toBeInstanceOf(RemoteError);

    await ide.request('remote.disable');
    await waitFor(() => relay.machines.size === 0);
    await expect(RemoteSession.connect(target, await generateKeyPair())).rejects.toMatchObject({
      motivo: 'offline',
    });
  }, 30_000);

  it('o relay recusa um Core sem a chave dele', async () => {
    await relay.close();
    relay = createRelay({ server, accessKey: 'chave-certa' });
    await startCore('  chave: chave-errada\n');
    await ide.request('remote.enable');
    await waitFor(() => core.remote?.status().estado === 'erro');
    expect(core.remote?.status().erro).toMatch(/recusou|refused/);
    const status = await ide.request<RemoteStatus>('remote.enable', { chave: 'chave-certa' });
    expect(status.ligado).toBe(true);
    await waitFor(() => relay.machines.size === 1);
  }, 30_000);

  it('remote.test confere o relay sem derrubar a conexão aberta', async () => {
    await startCore();
    await enable();
    const result = await ide.request<RemoteTestResult>('remote.test');
    expect(result).toMatchObject({ ok: true, relay: relayUrl, push: true });
    expect(result.aviso).toMatch(/FAKL_RELAY_KEY/);
    await waitFor(() => relay.machines.size === 1);
    expect(core.remote?.status().estado).toBe('ligado');

    expect(
      await ide.request<RemoteTestResult>('remote.test', { relay: 'ftp://relay.exemplo.com' }),
    ).toMatchObject({ ok: false, etapa: 'endereco' });
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(
      await ide.request<RemoteTestResult>('remote.test', {
        relay: `http://127.0.0.1:${String(port)}`,
      }),
    ).toMatchObject({ ok: false, etapa: 'https' });
  }, 30_000);

  it('remote.test diz quando a chave não confere', async () => {
    await relay.close();
    relay = createRelay({ server, accessKey: 'chave-certa' });
    await startCore('  chave: chave-errada\n');
    const wrong = await ide.request<RemoteTestResult>('remote.test');
    expect(wrong).toMatchObject({ ok: false, etapa: 'chave' });
    expect(wrong.mensagem).toMatch(/não confere|does not match/);
    const right = await ide.request<RemoteTestResult>('remote.test', {
      relay: relayUrl,
      chave: 'chave-certa',
    });
    expect(right).toMatchObject({ ok: true, push: false });
    expect(right.aviso).toBeUndefined();
    // O teste não grava nada: o config.yaml continua com a chave errada.
    expect(core.config?.config.remoto?.chave).toBe('chave-errada');
  }, 30_000);
});
