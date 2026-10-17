/** Aviso de versão nova para quem não tem atualização nativa, o macOS (ADR 0037). */

/** Onde a release publica o aviso; o `latest.json` da raiz da branch `atualizacoes`. */
export const UPDATE_NOTICE_URL =
  'https://raw.githubusercontent.com/FaKL-Code/FaKL-Code-IDE/atualizacoes/latest.json';

const RELEASES_PREFIX = 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/';

export interface UpdateNotice {
  readonly tag: string;
  /** Versão como a IDE a mostra e compara, de `productVersion` (ex. `1.135.101.0`). */
  readonly productVersion: string;
  readonly publishedAt: number;
  /** Página da release no GitHub. */
  readonly page: string;
  readonly platforms: Readonly<Record<string, { readonly url: string }>>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const isReleaseUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(RELEASES_PREFIX);

/**
 * Valida o JSON baixado. Vem da rede, então só vale se todos os links apontam para
 * as releases deste projeto: o botão do aviso abre `page`.
 */
export function parseUpdateNotice(raw: unknown): UpdateNotice | undefined {
  const data = asRecord(raw);
  const platforms = asRecord(data?.platforms);
  if (!data || !platforms) return undefined;
  const { tag, productVersion, publishedAt, page } = data;
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) return undefined;
  if (typeof productVersion !== 'string' || !/^\d+\.\d+\.\d+(\.\d+)?$/.test(productVersion)) {
    return undefined;
  }
  if (typeof publishedAt !== 'number' || !Number.isFinite(publishedAt)) return undefined;
  if (!isReleaseUrl(page)) return undefined;
  const checked: Record<string, { url: string }> = {};
  for (const [key, value] of Object.entries(platforms)) {
    const url = asRecord(value)?.url;
    if (isReleaseUrl(url)) checked[key] = { url };
  }
  return { tag, productVersion, publishedAt, page, platforms: checked };
}

/**
 * Parte numérica da versão como o serviço de atualização a compara: sem o quarto
 * número e sem zeros à esquerda (`1.135.0000101` e `1.135.101.0` dão `[1, 135, 101]`).
 */
export function versionParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?(?:-.+)?$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `true` se `candidate` é uma versão mais nova que `current`. */
export function isNewer(current: string, candidate: string): boolean {
  const a = versionParts(current);
  const b = versionParts(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (b[i] ?? 0) > (a[i] ?? 0);
  }
  return false;
}

/** Chave da plataforma no `latest.json` (`darwin-arm64`, `win32-x64`). */
export const platformKey = (platform: string, arch: string): string => `${platform}-${arch}`;

export interface NoticeContext {
  readonly currentVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly now: number;
  /** Idade mínima da release, em horas, para a IDE a oferecer (`update.minReleaseAge`). */
  readonly minReleaseAgeHours: number;
  /** Tag do último aviso já mostrado, para não repetir. */
  readonly lastNotified?: string | undefined;
}

export type NoticeDecision =
  | { readonly show: true; readonly tag: string; readonly page: string }
  | { readonly show: false; readonly reason: 'up-to-date' | 'no-build' | 'too-new' | 'already' };

/** O que fazer com o aviso baixado: mostrar ou ficar quieto (e por quê). */
export function decideNotice(notice: UpdateNotice, context: NoticeContext): NoticeDecision {
  if (!notice.platforms[platformKey(context.platform, context.arch)]) {
    return { show: false, reason: 'no-build' };
  }
  if (!isNewer(context.currentVersion, notice.productVersion)) {
    return { show: false, reason: 'up-to-date' };
  }
  const ageHours = (context.now - notice.publishedAt) / 3_600_000;
  if (ageHours < context.minReleaseAgeHours) return { show: false, reason: 'too-new' };
  if (context.lastNotified === notice.tag) return { show: false, reason: 'already' };
  return { show: true, tag: notice.tag, page: notice.page };
}
