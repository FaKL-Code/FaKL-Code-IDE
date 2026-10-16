import { afterEach, describe, expect, it } from 'vitest';

import {
  catalogFor,
  currentLocale,
  l10n,
  localeFromEnv,
  normalizeLocale,
  PT_BR,
  PT_BR_AREAS,
  useLocale,
} from '../src/index.js';

afterEach(() => {
  useLocale('en');
});

describe('idioma da interface', () => {
  it('reconhece todo português como pt-BR e o resto como inglês', () => {
    for (const raw of ['pt-BR', 'pt-br', 'pt', 'pt_BR.UTF-8', 'pt-PT', 'PT_br@euro']) {
      expect(normalizeLocale(raw)).toBe('pt-br');
    }
    for (const raw of ['en', 'en-US', 'de', 'es-419', '', undefined, 'C']) {
      expect(normalizeLocale(raw)).toBe('en');
    }
  });

  it('no Core e na CLI, FAKL_LOCALE vence as variáveis do sistema', () => {
    expect(localeFromEnv({ FAKL_LOCALE: 'en', LANG: 'pt_BR.UTF-8' })).toBe('en');
    expect(localeFromEnv({ LANG: 'pt_BR.UTF-8' })).toBe('pt-br');
    expect(localeFromEnv({ LC_ALL: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('pt-br');
    // "C" e "POSIX" não dizem idioma; cai no do Intl, que é en ou pt-br.
    expect(['en', 'pt-br']).toContain(localeFromEnv({ LANG: 'C' }));
  });

  it('traduz pelo catálogo pt-BR e devolve o inglês do código nos outros idiomas', () => {
    expect(useLocale('pt-BR')).toBe('pt-br');
    expect(currentLocale()).toBe('pt-br');
    expect(l10n.t('Next')).toBe('Próxima');
    expect(l10n.t('{0} of {1} done', 2, 5)).toBe('2 de 5 resolvidas');
    useLocale('de-DE');
    expect(currentLocale()).toBe('en');
    expect(l10n.t('Next')).toBe('Next');
    expect(l10n.t('{0} of {1} done', 2, 5)).toBe('2 of 5 done');
    expect(l10n.t('A text nobody translated')).toBe('A text nobody translated');
  });

  it('o catálogo inteiro junta as áreas, sem chave com dois textos', () => {
    const merged: Record<string, string> = {};
    for (const area of Object.values(PT_BR_AREAS)) {
      for (const [key, text] of Object.entries(area)) {
        if (key in merged) expect(merged[key]).toBe(text);
        merged[key] = text;
      }
    }
    expect(PT_BR).toEqual(merged);
    expect(catalogFor('pt-br')).toBe(PT_BR);
    expect(catalogFor('en')).toBeUndefined();
  });
});
