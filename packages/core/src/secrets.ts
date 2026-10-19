import { l10n } from '@fakl/i18n';
import { isMcpInputId, isProviderId } from '@fakl/protocol';

import {
  objectParams,
  RpcError,
  stringParam,
  type CallContext,
  type Router,
} from './rpc/router.js';

/** Segredos que o Core usa; a IDE guarda cada um no cofre do sistema (SDD 14.2). */
export const SECRET_NAMES = [
  'github.token',
  'hostinger.token',
  'voz.token',
  'remote.identidade',
  'vault.embeddings',
] as const;
/**
 * Chave da API de embeddings da busca semântica do vault (ADR 0050). Não reaproveita
 * `apikey.<provedor>`: essa vai ao ambiente dos agentes daquele provedor, e a chave
 * de embeddings só pode ir ao endpoint configurado em `vault.semantica`.
 */
export const EMBEDDINGS_SECRET = 'vault.embeddings';
/** Chave de 32 bytes que cifra `~/.fakl/remote/identity.json` (ADR 0044). */
export const REMOTE_IDENTITY_SECRET = 'remote.identidade';
/**
 * Os fixos, os `mcp.<id>` dos servidores MCP instalados na IDE (`${input:id}`)
 * e as `apikey.<provedor>`, chaves de API que só o agente daquele provedor recebe.
 */
export type SecretName = (typeof SECRET_NAMES)[number] | `mcp.${string}` | `apikey.${string}`;

function isMcpSecret(value: string): value is `mcp.${string}` {
  return value.startsWith('mcp.') && isMcpInputId(value.slice(4));
}

function isApiKeySecret(value: string): value is `apikey.${string}` {
  return value.startsWith('apikey.') && isProviderId(value.slice(7));
}

function isSecretName(value: string): value is SecretName {
  return (
    (SECRET_NAMES as readonly string[]).includes(value) ||
    isMcpSecret(value) ||
    isApiKeySecret(value)
  );
}

/**
 * Segredos em memória (ADR 0010). O Core não grava segredos: a extensão os
 * guarda no SecretStorage da IDE (cifrado pelo safeStorage, com Keychain no
 * macOS e DPAPI no Windows) e entrega aqui a cada abertura. Só conexões com o
 * token de sessão da IDE chegam a estes métodos; agentes e aparelhos remotos
 * não têm acesso a eles.
 */
export class SecretVault {
  private readonly values = new Map<SecretName, string>();
  private readonly listeners = new Set<(name: SecretName) => void>();

  get(name: SecretName): string | undefined {
    return this.values.get(name);
  }

  has(name: SecretName): boolean {
    return this.values.has(name);
  }

  set(name: SecretName, value: string | undefined): void {
    if (value) this.values.set(name, value);
    else this.values.delete(name);
    for (const listener of this.listeners) listener(name);
  }

  /** Todos os valores, para a varredura de segredos reconhecer os próprios. */
  all(): string[] {
    return [...this.values.values()];
  }

  onChange(listener: (name: SecretName) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  register(router: Router): void {
    const guard = (context: CallContext): void => {
      if (context.principal !== undefined) {
        throw RpcError.invalidParams(l10n.t('only the IDE stores secrets'));
      }
    };
    router.register('secrets.set', (params, context) => {
      guard(context);
      const p = objectParams(params);
      const name = stringParam(p, 'nome');
      if (!isSecretName(name)) throw RpcError.invalidParams(l10n.t('unknown secret: {0}', name));
      const value = p.valor;
      if (value !== null && (typeof value !== 'string' || !value)) {
        throw RpcError.invalidParams(l10n.t('valor must be non-empty text or null'));
      }
      this.set(name, value ?? undefined);
      return null;
    });
    router.register('secrets.status', () =>
      Object.fromEntries([
        ...SECRET_NAMES.map((name) => [name, this.values.has(name)]),
        ...[...this.values.keys()]
          .filter((name) => isMcpSecret(name) || isApiKeySecret(name))
          .map((name) => [name, true]),
      ]),
    );
  }
}
