import { describe, expect, it } from 'vitest';

import {
  decideNotice,
  isNewer,
  parseUpdateNotice,
  platformKey,
  versionParts,
  type NoticeContext,
} from '../src/update-model.js';

const PAGE = 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/tag/v0.1.1';
const MAC = 'https://github.com/FaKL-Code/FaKL-Code-IDE/releases/download/v0.1.1/mac.zip';

const raw = (patch: Record<string, unknown> = {}): unknown => ({
  tag: 'v0.1.1',
  name: '0.1.1',
  productVersion: '1.135.101.0',
  publishedAt: 1_000_000,
  page: PAGE,
  platforms: { 'darwin-arm64': { url: MAC, sha256: 'x' } },
  ...patch,
});

describe('parseUpdateNotice', () => {
  it('aceita o latest.json da release', () => {
    expect(parseUpdateNotice(raw())).toEqual({
      tag: 'v0.1.1',
      productVersion: '1.135.101.0',
      publishedAt: 1_000_000,
      page: PAGE,
      platforms: { 'darwin-arm64': { url: MAC } },
    });
  });

  it('recusa formatos errados', () => {
    for (const ruim of [
      null,
      'texto',
      raw({ tag: '0.1.1' }),
      raw({ tag: 'v0.1.1-rc1' }),
      raw({ productVersion: 'novo' }),
      raw({ publishedAt: '1000' }),
      raw({ platforms: undefined }),
    ]) {
      expect(parseUpdateNotice(ruim)).toBeUndefined();
    }
  });

  it('só confia em links das releases do projeto', () => {
    expect(parseUpdateNotice(raw({ page: 'https://exemplo.com/baixar' }))).toBeUndefined();
    expect(
      parseUpdateNotice(raw({ page: 'https://github.com/outro/repo/releases/tag/v1.0.0' })),
    ).toBeUndefined();
    const notice = parseUpdateNotice(
      raw({
        platforms: {
          'darwin-arm64': { url: MAC },
          'darwin-x64': { url: 'https://exemplo.com/mac.zip' },
          'win32-x64': {},
        },
      }),
    );
    expect(Object.keys(notice?.platforms ?? {})).toEqual(['darwin-arm64']);
  });
});

describe('versões', () => {
  it('lê os três números como o serviço de atualização', () => {
    expect(versionParts('1.135.0000101')).toEqual([1, 135, 101]);
    expect(versionParts('1.135.101.0')).toEqual([1, 135, 101]);
    expect(versionParts('1.135.06960')).toEqual([1, 135, 6960]);
    expect(versionParts('1.135')).toBeUndefined();
  });

  it('só considera mais nova a versão maior', () => {
    expect(isNewer('1.135.0000101', '1.135.102.0')).toBe(true);
    expect(isNewer('1.135.0000101', '1.135.101.0')).toBe(false);
    expect(isNewer('1.135.0000200', '1.135.101.0')).toBe(false);
    expect(isNewer('1.135.0000200', '1.136.1.0')).toBe(true);
    expect(isNewer('nada', '1.135.101.0')).toBe(false);
  });
});

describe('decideNotice', () => {
  const parsed = parseUpdateNotice(raw());
  if (!parsed) throw new Error('o latest.json de exemplo deveria ser válido');
  const notice = parsed;
  const context = (patch: Partial<NoticeContext> = {}): NoticeContext => ({
    currentVersion: '1.135.0000100',
    platform: 'darwin',
    arch: 'arm64',
    now: 1_000_000 + 48 * 3_600_000,
    minReleaseAgeHours: 24,
    ...patch,
  });

  it('chave da plataforma', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
  });

  it('mostra quando há versão nova, com idade suficiente, para esta plataforma', () => {
    expect(decideNotice(notice, context())).toEqual({ show: true, tag: 'v0.1.1', page: PAGE });
  });

  it('fica quieto se já está na versão ou numa mais nova', () => {
    expect(decideNotice(notice, context({ currentVersion: '1.135.0000101' }))).toEqual({
      show: false,
      reason: 'up-to-date',
    });
    expect(decideNotice(notice, context({ currentVersion: '1.135.0000200' })).show).toBe(false);
  });

  it('espera a idade mínima da release e não repete o aviso', () => {
    const cedo = context({ now: 1_000_000 + 2 * 3_600_000 });
    expect(decideNotice(notice, cedo)).toEqual({ show: false, reason: 'too-new' });
    expect(decideNotice(notice, context({ lastNotified: 'v0.1.1' }))).toEqual({
      show: false,
      reason: 'already',
    });
    expect(decideNotice(notice, context({ lastNotified: 'v0.1.0' })).show).toBe(true);
  });

  it('não avisa de build que a release não tem para este sistema', () => {
    expect(decideNotice(notice, context({ arch: 'x64' }))).toEqual({
      show: false,
      reason: 'no-build',
    });
  });

  it('idade mínima zero (pedido manual) mostra na hora', () => {
    const agora = context({ now: 1_000_000, minReleaseAgeHours: 0 });
    expect(decideNotice(notice, agora).show).toBe(true);
  });
});
