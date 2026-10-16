/**
 * Idioma da interface (fase de i18n da versão open source). O texto de origem
 * fica em inglês no código, em `l10n.t('...')`, como no VS Code; o pt-BR vem
 * dos catálogos em `catalogos/pt-br/`, um arquivo por área para que cada parte
 * do monorepo traduza sem disputar o mesmo arquivo. Idioma sem catálogo cai no
 * inglês do código.
 *
 * A extensão usa `vscode.l10n.t`, que lê o mesmo catálogo copiado para
 * `l10n/bundle.l10n.pt-br.json` no build. Webviews, app do celular, overlay,
 * Core e CLI usam o `l10n` daqui, depois de `useLocale`.
 */

import * as l10n from '@vscode/l10n';

import cli from './catalogos/pt-br/cli.json' with { type: 'json' };
import core from './catalogos/pt-br/core.json' with { type: 'json' };
import extensao from './catalogos/pt-br/extensao.json' with { type: 'json' };
import integracoes from './catalogos/pt-br/integracoes.json' with { type: 'json' };
import jornada from './catalogos/pt-br/jornada.json' with { type: 'json' };
import nucleo from './catalogos/pt-br/nucleo.json' with { type: 'json' };
import orquestrador from './catalogos/pt-br/orquestrador.json' with { type: 'json' };
import overlay from './catalogos/pt-br/overlay.json' with { type: 'json' };
import pacotes from './catalogos/pt-br/pacotes.json' with { type: 'json' };
import pwa from './catalogos/pt-br/pwa.json' with { type: 'json' };
import webviews from './catalogos/pt-br/webviews.json' with { type: 'json' };

export { l10n };

export const SUPPORTED_LOCALES = ['en', 'pt-br'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Catálogos por área, na ordem em que se juntam; uma chave não pode ter dois textos. */
export const PT_BR_AREAS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  cli,
  core,
  extensao,
  integracoes,
  jornada,
  nucleo,
  orquestrador,
  overlay,
  pacotes,
  pwa,
  webviews,
};

/** O catálogo pt-BR inteiro: texto em inglês → texto em português. */
export const PT_BR: Readonly<Record<string, string>> = Object.assign(
  {},
  ...Object.values(PT_BR_AREAS),
) as Record<string, string>;

/**
 * Qualquer forma de idioma (`pt-BR`, `pt_BR.UTF-8`, `pt`, `en-US`) no que a
 * interface sabe mostrar. Todo português vira pt-BR; o resto, inglês.
 */
export function normalizeLocale(raw: string | undefined): Locale {
  const lang = (raw ?? '').trim().toLowerCase().replace('_', '-').split(/[.@]/)[0] ?? '';
  return lang === 'pt' || lang.startsWith('pt-') ? 'pt-br' : 'en';
}

/**
 * Idioma de um processo sem VS Code (Core, CLI): `FAKL_LOCALE`, depois as
 * variáveis do sistema e, por fim, o idioma do Intl.
 */
export function localeFromEnv(env: Readonly<Record<string, string | undefined>>): Locale {
  for (const name of ['FAKL_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[name];
    // "C" e "POSIX" não dizem idioma nenhum.
    if (value && value !== 'C' && value !== 'POSIX') return normalizeLocale(value);
  }
  return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
}

export function catalogFor(locale: Locale): Readonly<Record<string, string>> | undefined {
  return locale === 'pt-br' ? PT_BR : undefined;
}

let current: Locale = 'en';

/** Passa a traduzir para `locale`; o inglês é o próprio texto do código. */
export function useLocale(locale: string | undefined): Locale {
  current = normalizeLocale(locale);
  l10n.config({ contents: { ...catalogFor(current) } });
  return current;
}

export function currentLocale(): Locale {
  return current;
}
