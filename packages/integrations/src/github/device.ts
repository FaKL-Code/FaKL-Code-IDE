import { l10n } from '@fakl/i18n';

import { errorMessage, HttpError, readBody, type FetchLike } from '../http.js';

/** Escopos do login: repositórios, Actions (workflow), notificações e leitura da org. */
export const GITHUB_SCOPES = ['repo', 'workflow', 'notifications', 'read:org'];

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

interface DeviceOptions {
  readonly fetch?: FetchLike;
  /** Padrão: https://github.com */
  readonly baseUrl?: string;
}

async function post(
  url: string,
  form: Record<string, string>,
  fetchFn: FetchLike,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await readBody(response);
  if (!response.ok || typeof data !== 'object' || data === null) {
    throw new HttpError(
      response.status,
      errorMessage(data, l10n.t('GitHub refused the request')),
      data,
    );
  }
  return data as Record<string, unknown>;
}

/**
 * Primeiro passo do device flow (SDD 11.1): pede um código que você digita em
 * github.com/login/device. Exige um OAuth App com device flow ligado.
 */
export async function requestDeviceCode(
  clientId: string,
  options: DeviceOptions & { scopes?: readonly string[] } = {},
): Promise<DeviceCode> {
  const base = options.baseUrl ?? 'https://github.com';
  const data = await post(
    `${base}/login/device/code`,
    { client_id: clientId, scope: (options.scopes ?? GITHUB_SCOPES).join(' ') },
    options.fetch ?? ((url, init) => fetch(url, init)),
  );
  if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
    throw new HttpError(400, errorMessage(data, l10n.t('unexpected response from GitHub')), data);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri:
      typeof data.verification_uri === 'string' ? data.verification_uri : `${base}/login/device`,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 900,
    interval: typeof data.interval === 'number' ? data.interval : 5,
  };
}

export class DeviceFlowError extends Error {
  override readonly name = 'DeviceFlowError';

  constructor(
    readonly motivo: 'expirado' | 'negado' | 'cancelado' | 'erro',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Espera você autorizar o código e devolve o token. Respeita o intervalo
 * pedido pelo GitHub (e o aumento de `slow_down`) e para no prazo do código.
 */
export async function pollDeviceToken(
  clientId: string,
  code: DeviceCode,
  options: DeviceOptions & {
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<string> {
  const base = options.baseUrl ?? 'https://github.com';
  const fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;
  for (;;) {
    await sleep(interval * 1000);
    if (options.signal?.aborted) throw new DeviceFlowError('cancelado', l10n.t('sign-in canceled'));
    if (now() > deadline)
      throw new DeviceFlowError('expirado', l10n.t('the code expired; try again'));
    const data = await post(
      `${base}/login/oauth/access_token`,
      {
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
      fetchFn,
    );
    if (typeof data.access_token === 'string' && data.access_token) return data.access_token;
    switch (data.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval = typeof data.interval === 'number' ? data.interval : interval + 5;
        continue;
      case 'expired_token':
        throw new DeviceFlowError('expirado', l10n.t('the code expired; try again'));
      case 'access_denied':
        throw new DeviceFlowError('negado', l10n.t('sign-in was denied on GitHub'));
      default:
        throw new DeviceFlowError('erro', errorMessage(data, l10n.t('GitHub refused the sign-in')));
    }
  }
}
