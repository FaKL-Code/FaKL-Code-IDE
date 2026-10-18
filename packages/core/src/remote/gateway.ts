import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

import {
  FaklErrorCode,
  type RemoteDeviceInfo,
  type RemotePairingInfo,
  type RemoteStatus,
  type RemoteTestResult,
} from '@fakl/protocol';
import {
  ChannelError,
  CHANNEL_VERSION,
  decodeKey,
  DEFAULT_SCOPES,
  deriveChannel,
  encodeKey,
  exportKeyPair,
  fingerprint,
  generateKeyPair,
  importKeyPair,
  isRemoteScope,
  machineIdFromSecret,
  methodsForScopes,
  pairingUrl,
  parseFrame,
  relaySocketUrl,
  type CoreHello,
  type CoreToRelay,
  type DeviceHello,
  type KeyPair,
  type PlainError,
  type PushMessage,
  type PushSubscriptionData,
  type RelayToCore,
  type RemoteScope,
  type SecureChannel,
} from '@fakl/remote';
import { l10n } from '@fakl/i18n';

import type { RemoteConfig } from '../config.js';
import type { Disposable, EventBus } from '../events/bus.js';
import {
  objectParams,
  RpcError,
  stringParam,
  type CallContext,
  type Router,
} from '../rpc/router.js';
import type { AttachedConnection, RpcServer } from '../rpc/server.js';
import { readJson, writeJsonAtomic } from '../store.js';
import { ulid } from '../ulid.js';
import {
  openIdentity,
  parseIdentityKey,
  readIdentityFile,
  writeSealedIdentity,
  type StoredIdentity,
} from './identity-store.js';
import { testRelay } from './relay-test.js';

interface StoredDevice {
  readonly id: string;
  readonly nome: string;
  /** Chave pública fixa do aparelho. */
  readonly chave: string;
  readonly escopos: readonly RemoteScope[];
  readonly criadoEm: string;
  ultimoAcesso?: string;
  push?: PushSubscriptionData;
}

interface Pairing {
  readonly id: string;
  readonly code: string;
  readonly expires: number;
  attempts: number;
  /** Aparelho esperando a confirmação na IDE. */
  waiting?: (answer: { aceitar: boolean; escopos: readonly RemoteScope[] }) => void;
}

interface ChannelState {
  readonly ch: string;
  phase: 'hello' | 'aberto' | 'fechado';
  channel?: SecureChannel;
  mode?: DeviceHello['modo'];
  /** Chave fixa que o aparelho apresentou no hello. */
  deviceKey?: string;
  device?: StoredDevice;
  rpc?: AttachedConnection;
  /** Processa as mensagens em ordem. */
  queue: Promise<void>;
}

export interface RemoteGatewayOptions {
  readonly bus: EventBus;
  readonly server: RpcServer;
  /** `~/.fakl/remote`: identidade da máquina e aparelhos pareados. */
  readonly dir: string;
  readonly config: () => RemoteConfig | undefined;
  /** Grava relay e chave no config.yaml quando a IDE os informa. */
  readonly saveConfig?: (change: RemoteConfig) => Promise<void>;
  readonly log?: (message: string) => void;
  /**
   * Chave de 32 bytes (base64url) que a IDE guarda no cofre do sistema e
   * entrega ao Core em memória (`remote.identidade`, ADR 0044). Com ela, a
   * identidade é gravada cifrada. Sem esta opção, o arquivo fica em claro.
   */
  readonly identityKey?: () => string | undefined;
  /** Quanto o Core espera a chave da IDE antes de seguir sem ela (padrão 10 s). */
  readonly keyWaitMs?: number;
  /** Troca o WebSocket nos testes. */
  readonly WebSocket?: typeof WebSocket;
  /** Troca o fetch do `remote.test` nos testes. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

// O link costuma ir por mensagem para o celular; 2 min era pouco.
const PAIRING_MS = 10 * 60_000;
const MAX_PAIRING_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 60_000;
/**
 * Maior mensagem em claro para um aparelho. O relay derruba quadros acima de
 * 1 MB, e a cifra em base64 e o envelope crescem a mensagem em cerca de 40%.
 */
export const MAX_REMOTE_MESSAGE_BYTES = 700_000;

/**
 * A mensagem como pode ir ao aparelho: uma resposta grande demais vira erro
 * (em vez de derrubar o canal no relay) e uma notificação grande demais some.
 */
export function fitForRelay(message: unknown): unknown {
  const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
  if (size <= MAX_REMOTE_MESSAGE_BYTES) return message;
  const m = message as { id?: unknown };
  if (m.id === undefined || m.id === null) return undefined;
  return {
    jsonrpc: '2.0',
    id: m.id,
    error: {
      code: FaklErrorCode.LimitExceeded,
      message: l10n.t(
        'response too large for remote control ({0} KB)',
        String(Math.round(size / 1024)),
      ),
    },
  };
}

/** Notificações mínimas (SDD 12.4): os detalhes só aparecem dentro do app. */
const PUSH_FOR: Partial<Record<string, (data: unknown) => PushMessage | undefined>> = {
  'run.decision': () => ({
    titulo: 'FaKL-Code',
    texto: l10n.t('A decision is waiting for you'),
    tag: 'decisao',
  }),
  'agent.permission': () => ({
    titulo: 'FaKL-Code',
    texto: l10n.t('An agent is asking for permission'),
    tag: 'permissao',
  }),
  'run.done': (data) => {
    const status = (data as { status?: string }).status;
    if (status === 'concluída')
      return { titulo: 'FaKL-Code', texto: l10n.t('A run finished'), tag: 'execucao' };
    if (status === 'falhou')
      return { titulo: 'FaKL-Code', texto: l10n.t('A run failed'), tag: 'execucao' };
    return undefined;
  },
};

/**
 * Gateway do controle remoto (SDD 12). Abre uma conexão de saída até o relay,
 * atende os aparelhos por canais cifrados de ponta a ponta e os liga à mesma
 * API do Core, limitada pelos escopos de cada aparelho.
 */
export class RemoteGateway implements Disposable {
  private identity: { segredo: string; machine: string; key: KeyPair } | undefined;
  private devices: StoredDevice[] = [];
  private socket: WebSocket | undefined;
  private state: RemoteStatus['estado'] = 'desligado';
  private error: string | undefined;
  private enabled = false;
  private backoff = 1_000;
  private retry: NodeJS.Timeout | undefined;
  private pairing: Pairing | undefined;
  private readonly channels = new Map<string, ChannelState>();
  private readonly pushWaiters = new Map<string, string>();
  private readonly subscription: Disposable;
  private loaded: Promise<void> | undefined;
  /** Chave com que o arquivo da identidade está cifrado; vazio se está em claro. */
  private sealedWith: Buffer | undefined;
  /** Identidade em memória, para regravar quando a chave muda. */
  private stored: StoredIdentity | undefined;
  private readonly keyWaiters: (() => void)[] = [];
  private startFailed = false;
  private resealing: Promise<void> = Promise.resolve();

  constructor(private readonly options: RemoteGatewayOptions) {
    this.subscription = options.bus.subscribe(Object.keys(PUSH_FOR), (event) => {
      const message = PUSH_FOR[event.topic]?.(event.data);
      if (message) this.pushAll(message);
    });
  }

  private get devicesFile(): string {
    return join(this.options.dir, 'devices.json');
  }

  private get identityFile(): string {
    return join(this.options.dir, 'identity.json');
  }

  /** Lê identidade e aparelhos; cria a identidade na primeira vez. */
  load(): Promise<void> {
    this.loaded ??= this.loadIdentity().catch((error: unknown) => {
      // Falhou (sem a chave, chave errada): uma nova tentativa pode dar certo.
      this.loaded = undefined;
      throw error;
    });
    return this.loaded;
  }

  private currentKey(): Buffer | undefined {
    return parseIdentityKey(this.options.identityKey?.());
  }

  /** Espera a IDE entregar a chave, por no máximo `keyWaitMs`. */
  private async waitForKey(): Promise<Buffer | undefined> {
    const key = this.currentKey();
    if (key || !this.options.identityKey) return key;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.options.keyWaitMs ?? 10_000);
      timer.unref();
      this.keyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.currentKey();
  }

  private async loadIdentity(): Promise<void> {
    const file = this.identityFile;
    const read = await readIdentityFile(file);
    if (read.kind === 'corrompido') {
      throw new Error(
        l10n.t(
          'the remote identity file cannot be read ({0}); restore it from a backup or delete {1} and {2} to pair the devices again',
          read.motivo,
          file,
          this.devicesFile,
        ),
      );
    }
    const key = await this.waitForKey();
    let stored: StoredIdentity;
    if (read.kind === 'cifrado') {
      if (!key) {
        throw new Error(
          l10n.t('the remote identity is encrypted and the IDE has not provided the key yet'),
        );
      }
      const opened = openIdentity(read.sealed, key);
      if (!opened) {
        throw new Error(
          l10n.t(
            'the remote identity cannot be opened: wrong key or altered file; delete {0} and {1} to pair the devices again',
            file,
            this.devicesFile,
          ),
        );
      }
      stored = opened;
      this.sealedWith = key;
    } else if (read.kind === 'claro') {
      stored = read.identity;
      await this.sealStored(stored, key);
    } else {
      const created: StoredIdentity = {
        segredo: randomBytes(32).toString('base64url'),
        chave: await exportKeyPair(await generateKeyPair(true)),
      };
      stored = created;
      if (key) {
        await writeSealedIdentity(file, created, key);
        this.sealedWith = key;
      } else {
        await writeJsonAtomic(file, created);
        this.warnPlainIdentity();
      }
    }
    this.stored = stored;
    this.identity = {
      segredo: stored.segredo,
      machine: await machineIdFromSecret(stored.segredo),
      key: await importKeyPair(stored.chave),
    };
    this.devices = (await readJson<StoredDevice[]>(this.devicesFile)) ?? [];
  }

  private warnPlainIdentity(): void {
    this.options.log?.(
      l10n.t(
        'remote identity kept in plain text: the IDE has not provided the encryption key (running without the IDE)',
      ),
    );
  }

  /**
   * Migra o arquivo em claro para cifrado quando há chave. Sem chave, segue em
   * claro com aviso; se a gravação falhar, o gateway continua como estava.
   */
  private async sealStored(stored: StoredIdentity, key: Buffer | undefined): Promise<void> {
    if (!key) {
      this.warnPlainIdentity();
      return;
    }
    try {
      await writeSealedIdentity(this.identityFile, stored, key);
      this.sealedWith = key;
      this.options.log?.(l10n.t('remote identity migrated to an encrypted file'));
    } catch (error) {
      this.options.log?.(l10n.t('could not encrypt the remote identity: {0}', String(error)));
    }
  }

  /**
   * A IDE entregou (ou trocou) a chave da identidade. Libera quem esperava,
   * migra a identidade em claro e tenta de novo a abertura que falhou por falta
   * da chave.
   */
  keyChanged(): void {
    for (const waiter of this.keyWaiters.splice(0)) waiter();
    const key = this.currentKey();
    if (!key) return;
    if (this.identity && this.loaded) {
      if (this.sealedWith?.equals(key)) return;
      const stored = this.stored;
      this.resealing = this.resealing
        .then(() => (stored ? this.sealStored(stored, key) : undefined))
        .catch(() => undefined);
    } else if (!this.loaded && this.startFailed) {
      this.startFailed = false;
      void this.start().catch((error: unknown) => {
        this.options.log?.(l10n.t('could not enable remote access: {0}', String(error)));
      });
    }
  }

  /** Liga se o config.yaml pede `ligarAoAbrir`. */
  async start(): Promise<void> {
    try {
      await this.load();
    } catch (error) {
      this.startFailed = true;
      this.setState('erro', error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (this.state === 'erro' && !this.enabled) this.setState('desligado');
    if (this.options.config()?.ligarAoAbrir && this.options.config()?.relay) await this.enable();
  }

  dispose(): void {
    this.subscription.dispose();
    this.disable();
  }

  status(): RemoteStatus {
    const config = this.options.config();
    return {
      ligado: this.enabled,
      estado: this.state,
      ...(config?.relay ? { relay: config.relay } : {}),
      ...(this.error ? { erro: this.error } : {}),
      conectados: [...this.channels.values()].filter((c) => c.phase === 'aberto' && c.device)
        .length,
      aparelhos: this.devices.length,
      ...(this.pairing && this.pairing.expires > Date.now()
        ? { pareamentoExpiraEm: new Date(this.pairing.expires).toISOString() }
        : {}),
    };
  }

  private setState(state: RemoteStatus['estado'], error?: string): void {
    this.state = state;
    this.error = error;
    this.options.bus.publish('remote.status', 'remote', this.status());
  }

  // ---------------------------------------------------------------- relay

  /**
   * `remote.test`: confere o relay (o informado ou o do config.yaml) sem
   * mexer na conexão aberta. Sem `chave` explícita, vale a do config.yaml.
   */
  async test(params: { relay?: string; chave?: string } = {}): Promise<RemoteTestResult> {
    const config = this.options.config();
    const relay = params.relay ?? config?.relay;
    if (!relay) {
      return {
        ok: false,
        etapa: 'endereco',
        mensagem: l10n.t(
          'no relay configured: enter the address, such as https://relay.example.com',
        ),
      };
    }
    const chave = params.chave ?? config?.chave;
    return testRelay({
      relay,
      ...(chave ? { chave } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.WebSocket ? { WebSocket: this.options.WebSocket } : {}),
    });
  }

  async enable(): Promise<RemoteStatus> {
    await this.load();
    const relay = this.options.config()?.relay;
    if (!relay) {
      throw RpcError.invalidParams(
        l10n.t('set remoto.relay in config.yaml to the address of your relay'),
      );
    }
    this.enabled = true;
    this.backoff = 1_000;
    this.connect();
    return this.status();
  }

  disable(): RemoteStatus {
    this.enabled = false;
    clearTimeout(this.retry);
    for (const state of this.channels.values()) this.closeChannel(state, false);
    this.channels.clear();
    this.cancelPairing();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, 'desligado');
    this.setState('desligado');
    return this.status();
  }

  private connect(): void {
    const identity = this.identity;
    const config = this.options.config();
    if (!this.enabled || !identity || !config?.relay) return;
    clearTimeout(this.retry);
    this.setState('conectando');
    const Impl = this.options.WebSocket ?? globalThis.WebSocket;
    let socket: WebSocket;
    try {
      socket = new Impl(relaySocketUrl(config.relay, '/core'));
    } catch (error) {
      this.setState('erro', l10n.t('invalid relay address: {0}', String(error)));
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      const auth: CoreToRelay = {
        t: 'auth',
        m: identity.machine,
        s: identity.segredo,
        ...(config.chave ? { k: config.chave } : {}),
      };
      socket.send(JSON.stringify(auth));
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let frame: RelayToCore;
      try {
        frame = JSON.parse(event.data) as RelayToCore;
      } catch {
        return;
      }
      this.onRelay(frame);
    });
    socket.addEventListener('close', (event: { code: number; reason: string }) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const state of this.channels.values()) this.closeChannel(state, false);
      this.channels.clear();
      if (!this.enabled) return;
      if (event.code === 4403) {
        // Recusado pelo relay: não adianta insistir sem mudar a configuração.
        this.enabled = false;
        this.setState(
          'erro',
          l10n.t('the relay refused: {0}', event.reason || l10n.t('access denied')),
        );
        return;
      }
      if (event.code === 4409) {
        this.setState('erro', l10n.t('another instance on this machine connected to the relay'));
      } else {
        this.setState('conectando', l10n.t('no connection to the relay; trying again'));
      }
      this.retry = setTimeout(() => {
        this.connect();
      }, this.backoff);
      this.retry.unref();
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
    socket.addEventListener('error', () => {
      // O 'close' vem em seguida e cuida da nova tentativa.
    });
  }

  private sendRelay(frame: CoreToRelay): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame));
  }

  private onRelay(frame: RelayToCore): void {
    switch (frame.t) {
      case 'ok':
        this.backoff = 1_000;
        this.setState('ligado');
        this.options.log?.(l10n.t('remote access on'));
        break;
      case 'recusado':
        this.setState('erro', l10n.t('the relay refused: {0}', frame.motivo));
        break;
      case 'open':
        this.channels.set(frame.ch, { ch: frame.ch, phase: 'hello', queue: Promise.resolve() });
        break;
      case 'data': {
        const state = this.channels.get(frame.ch);
        if (!state) return;
        state.queue = state.queue
          .then(() => this.onChannel(state, frame.d))
          .catch((error: unknown) => {
            if (!(error instanceof ChannelError)) {
              this.options.log?.(l10n.t('remote channel: {0}', String(error)));
            }
            this.closeChannel(state, true);
          });
        break;
      }
      case 'close': {
        const state = this.channels.get(frame.ch);
        if (state) this.closeChannel(state, false);
        break;
      }
      case 'push': {
        const deviceId = this.pushWaiters.get(frame.id);
        this.pushWaiters.delete(frame.id);
        if (frame.expirada && deviceId) {
          const device = this.devices.find((d) => d.id === deviceId);
          if (device) {
            delete device.push;
            void this.saveDevices();
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- canais

  private plain(state: ChannelState, error: PlainError['motivo']): void {
    const message: PlainError = { t: 'erro', motivo: error };
    this.sendRelay({ t: 'data', ch: state.ch, d: JSON.stringify(message) });
    this.closeChannel(state, true);
  }

  private closeChannel(state: ChannelState, tellRelay: boolean): void {
    if (state.phase === 'fechado') return;
    const wasOpen = state.phase === 'aberto' && state.device;
    state.phase = 'fechado';
    state.rpc?.close();
    this.channels.delete(state.ch);
    if (tellRelay) this.sendRelay({ t: 'close', ch: state.ch });
    if (wasOpen && state.device) {
      this.options.bus.publish('remote.device', state.device.id, {
        tipo: 'desconectado',
        aparelho: this.info(state.device),
      });
    }
  }

  private async send(state: ChannelState, message: unknown): Promise<void> {
    if (!state.channel || state.phase === 'fechado') return;
    this.sendRelay({ t: 'data', ch: state.ch, d: await state.channel.seal(message) });
  }

  private async onChannel(state: ChannelState, text: string): Promise<void> {
    const identity = this.identity;
    if (!identity || state.phase === 'fechado') return;
    const frame = parseFrame(text);
    if (state.phase === 'hello') {
      if (frame.t !== 'hello' || !('modo' in frame)) {
        this.plain(state, 'protocolo');
        return;
      }
      if (frame.v !== CHANNEL_VERSION) {
        this.plain(state, 'versao');
        return;
      }
      let code: string | undefined;
      if (frame.modo === 'parear') {
        const pairing = this.pairing;
        if (!pairing || pairing.expires < Date.now() || pairing.waiting) {
          this.plain(state, 'codigo');
          return;
        }
        code = pairing.code;
      } else {
        const device = this.devices.find((d) => d.chave === frame.dev);
        if (!device) {
          this.plain(state, 'desconhecido');
          return;
        }
        state.device = device;
      }
      const ephemeral = await generateKeyPair();
      state.mode = frame.modo;
      state.channel = await deriveChannel({
        role: 'core',
        mode: frame.modo,
        mine: identity.key,
        ephemeral,
        peerStatic: decodeKey(frame.dev),
        peerEphemeral: decodeKey(frame.eph),
        ...(code ? { code } : {}),
      });
      state.deviceKey = frame.dev;
      const hello: CoreHello = { t: 'hello', eph: encodeKey(ephemeral.raw) };
      this.sendRelay({ t: 'data', ch: state.ch, d: JSON.stringify(hello) });
      state.phase = 'aberto';
      return;
    }

    if (frame.t !== 'box' || !state.channel) {
      this.closeChannel(state, true);
      return;
    }
    let message: unknown;
    try {
      message = await state.channel.open(frame);
    } catch (error) {
      if (state.mode === 'parear' && this.pairing) {
        // Código errado: depois de algumas tentativas, o código morre.
        this.pairing.attempts++;
        if (this.pairing.attempts >= MAX_PAIRING_ATTEMPTS) this.cancelPairing();
        this.plain(state, 'codigo');
        return;
      }
      throw error;
    }

    if (state.mode === 'parear') {
      await this.onPairRequest(state, message);
      return;
    }
    const device = state.device;
    if (!device) return;
    if (!state.rpc) {
      // Primeiro box válido: o aparelho provou que tem a chave dele.
      if (!this.devices.includes(device)) {
        this.closeChannel(state, true);
        return;
      }
      state.rpc = this.options.server.attach(
        { principal: `remote:${device.id}`, methods: methodsForScopes(device.escopos) },
        (reply) => {
          const fitted = fitForRelay(reply);
          if (fitted === undefined) {
            this.options.log?.(l10n.t('notification too large for remote control; discarded'));
            return;
          }
          void this.send(state, fitted).catch(() => {
            this.closeChannel(state, true);
          });
        },
      );
      device.ultimoAcesso = new Date().toISOString();
      void this.saveDevices();
      this.options.bus.publish('remote.device', device.id, {
        tipo: 'conectado',
        aparelho: this.info(device),
      });
      this.options.log?.(l10n.t('remote device connected: {0}', device.nome));
    }
    await state.rpc.receive(message);
  }

  // ---------------------------------------------------------------- pareamento

  async beginPairing(): Promise<RemotePairingInfo> {
    await this.load();
    const identity = this.identity;
    const config = this.options.config();
    if (!identity || !config?.relay) {
      throw RpcError.invalidParams(
        l10n.t('set remoto.relay in config.yaml to the address of your relay'),
      );
    }
    if (!this.enabled) await this.enable();
    this.cancelPairing();
    const pairing: Pairing = {
      id: ulid(),
      code: randomBytes(16).toString('base64url'),
      expires: Date.now() + PAIRING_MS,
      attempts: 0,
    };
    this.pairing = pairing;
    setTimeout(() => {
      if (this.pairing === pairing && !pairing.waiting) this.cancelPairing();
    }, PAIRING_MS).unref();
    const url = pairingUrl({
      v: 1,
      r: config.relay,
      m: identity.machine,
      k: encodeKey(identity.key.raw),
      c: pairing.code,
      n: config.nome ?? hostname(),
    });
    this.options.bus.publish('remote.status', 'remote', this.status());
    return {
      pairingId: pairing.id,
      url,
      expiraEm: new Date(pairing.expires).toISOString(),
      impressao: await fingerprint(identity.key.raw),
    };
  }

  cancelPairing(): void {
    const pairing = this.pairing;
    this.pairing = undefined;
    pairing?.waiting?.({ aceitar: false, escopos: [] });
  }

  private async onPairRequest(state: ChannelState, message: unknown): Promise<void> {
    const pairing = this.pairing;
    const request = message as { t?: unknown; nome?: unknown };
    const { deviceKey } = state;
    if (!pairing || request.t !== 'parear' || !deviceKey || pairing.waiting) {
      this.closeChannel(state, true);
      return;
    }
    const nome =
      typeof request.nome === 'string' && request.nome.trim()
        ? request.nome.trim().slice(0, 60)
        : 'Aparelho';
    const impressao = await fingerprint(decodeKey(deviceKey));
    const answer = await new Promise<{ aceitar: boolean; escopos: readonly RemoteScope[] }>(
      (resolve) => {
        pairing.waiting = resolve;
        this.options.bus.publish('remote.device', pairing.id, {
          tipo: 'pedido',
          pairingId: pairing.id,
          nome,
          impressao,
        });
        const timer = setTimeout(() => {
          resolve({ aceitar: false, escopos: [] });
        }, PAIRING_MS);
        timer.unref();
      },
    );
    // O código é de uso único, aceito ou não.
    if (this.pairing === pairing) this.pairing = undefined;
    if (!answer.aceitar || state.phase === 'fechado') {
      await this.send(state, { t: 'recusado' });
      this.closeChannel(state, true);
      this.options.bus.publish('remote.status', 'remote', this.status());
      return;
    }
    const existing = this.devices.find((d) => d.chave === deviceKey);
    const device: StoredDevice = existing ?? {
      id: ulid(),
      nome,
      chave: deviceKey,
      escopos: answer.escopos.length > 0 ? answer.escopos : DEFAULT_SCOPES,
      criadoEm: new Date().toISOString(),
    };
    if (!existing) this.devices.push(device);
    await this.saveDevices();
    await this.send(state, { t: 'pareado', id: device.id, escopos: device.escopos });
    this.closeChannel(state, true);
    this.options.bus.publish('remote.device', device.id, {
      tipo: 'pareado',
      aparelho: this.info(device),
    });
    this.options.bus.publish('remote.status', 'remote', this.status());
  }

  confirmPairing(pairingId: string, aceitar: boolean, escopos: readonly RemoteScope[]): void {
    const pairing = this.pairing;
    if (pairing?.id !== pairingId || !pairing.waiting) {
      throw RpcError.notFound(l10n.t('no device waiting for this pairing'));
    }
    pairing.waiting({ aceitar, escopos });
  }

  // ---------------------------------------------------------------- aparelhos

  private info(device: StoredDevice): RemoteDeviceInfo {
    return {
      id: device.id,
      nome: device.nome,
      escopos: device.escopos,
      criadoEm: device.criadoEm,
      ...(device.ultimoAcesso ? { ultimoAcesso: device.ultimoAcesso } : {}),
      conectado: [...this.channels.values()].some(
        (c) => c.phase === 'aberto' && c.device?.id === device.id && c.rpc,
      ),
      push: device.push !== undefined,
    };
  }

  listDevices(): RemoteDeviceInfo[] {
    return this.devices.map((device) => this.info(device));
  }

  /** Revoga na hora (RF-305): apaga a chave e derruba o canal. */
  async revoke(id: string): Promise<void> {
    const device = this.devices.find((d) => d.id === id);
    if (!device) throw RpcError.notFound(l10n.t('device {0} does not exist', id));
    this.devices = this.devices.filter((d) => d !== device);
    await this.saveDevices();
    for (const state of [...this.channels.values()]) {
      if (state.device?.id === id) this.closeChannel(state, true);
    }
    this.options.bus.publish('remote.device', id, {
      tipo: 'revogado',
      aparelho: this.info(device),
    });
    this.options.bus.publish('remote.status', 'remote', this.status());
  }

  async setScopes(id: string, escopos: readonly RemoteScope[]): Promise<RemoteDeviceInfo> {
    const index = this.devices.findIndex((d) => d.id === id);
    const device = this.devices[index];
    if (!device) throw RpcError.notFound(l10n.t('device {0} does not exist', id));
    const updated: StoredDevice = { ...device, escopos };
    this.devices[index] = updated;
    await this.saveDevices();
    // Escopos novos valem na próxima conexão; derruba a atual.
    for (const state of [...this.channels.values()]) {
      if (state.device?.id === id) this.closeChannel(state, true);
    }
    return this.info(updated);
  }

  private async saveDevices(): Promise<void> {
    await writeJsonAtomic(this.devicesFile, this.devices);
  }

  private deviceFromContext(context: CallContext): StoredDevice {
    const id = context.principal?.startsWith('remote:') ? context.principal.slice(7) : undefined;
    const device = id ? this.devices.find((d) => d.id === id) : undefined;
    if (!device) throw RpcError.invalidParams(l10n.t('only a remote device can do this'));
    return device;
  }

  private pushAll(message: PushMessage): void {
    if (this.state !== 'ligado') return;
    for (const device of this.devices) {
      if (!device.push || !device.escopos.includes('ver')) continue;
      const id = ulid();
      this.pushWaiters.set(id, device.id);
      this.sendRelay({ t: 'push', id, sub: device.push, msg: message });
    }
  }

  // ---------------------------------------------------------------- API

  register(router: Router): void {
    router.register('remote.status', () => this.status());
    router.register('remote.test', (params) => {
      const p = params === undefined || params === null ? {} : objectParams(params);
      for (const key of ['relay', 'chave'] as const) {
        if (p[key] !== undefined && typeof p[key] !== 'string') {
          throw RpcError.invalidParams(l10n.t('{0} must be text', key));
        }
      }
      const relay = typeof p.relay === 'string' && p.relay.trim() ? p.relay : undefined;
      const chave = typeof p.chave === 'string' && p.chave ? p.chave : undefined;
      return this.test({ ...(relay ? { relay } : {}), ...(chave ? { chave } : {}) });
    });
    router.register('remote.enable', async (params) => {
      const p = params === undefined ? {} : objectParams(params);
      const change = {
        ...(typeof p.relay === 'string' && p.relay ? { relay: p.relay } : {}),
        ...(typeof p.chave === 'string' && p.chave ? { chave: p.chave } : {}),
        ...(typeof p.ligarAoAbrir === 'boolean' ? { ligarAoAbrir: p.ligarAoAbrir } : {}),
      };
      if (Object.keys(change).length > 0) {
        if (!this.options.saveConfig)
          throw RpcError.invalidParams(l10n.t('configuration unavailable'));
        try {
          await this.options.saveConfig(change);
        } catch (error) {
          throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
        }
        if (this.enabled) this.disable();
      }
      return this.enable();
    });
    router.register('remote.disable', () => this.disable());
    router.register('remote.pair.begin', () => this.beginPairing());
    router.register('remote.pair.cancel', () => {
      this.cancelPairing();
      return null;
    });
    router.register('remote.pair.confirm', (params) => {
      const p = objectParams(params);
      const escopos = Array.isArray(p.escopos)
        ? p.escopos.filter(isRemoteScope)
        : [...DEFAULT_SCOPES];
      this.confirmPairing(stringParam(p, 'pairingId'), p.aceitar === true, escopos);
      return null;
    });
    router.register('remote.devices.list', () => this.listDevices());
    router.register('remote.devices.revoke', async (params) => {
      await this.revoke(stringParam(objectParams(params), 'id'));
      return null;
    });
    router.register('remote.devices.update', (params) => {
      const p = objectParams(params);
      if (!Array.isArray(p.escopos) || !p.escopos.every(isRemoteScope)) {
        throw RpcError.invalidParams(l10n.t('escopos must list ver, decidir, comandar or editor'));
      }
      return this.setScopes(stringParam(p, 'id'), p.escopos);
    });
    router.register('remote.push.subscribe', async (params, context) => {
      const device = this.deviceFromContext(context);
      const sub = objectParams(params).sub as Partial<PushSubscriptionData> | undefined;
      if (
        typeof sub?.endpoint !== 'string' ||
        !sub.endpoint.startsWith('https://') ||
        typeof sub.keys?.p256dh !== 'string' ||
        typeof sub.keys.auth !== 'string'
      ) {
        throw RpcError.invalidParams(l10n.t('invalid push subscription'));
      }
      device.push = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      };
      await this.saveDevices();
      return null;
    });
    router.register('remote.push.unsubscribe', async (_params, context) => {
      const device = this.deviceFromContext(context);
      delete device.push;
      await this.saveDevices();
      return null;
    });
  }
}
