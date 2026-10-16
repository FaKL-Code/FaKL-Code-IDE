import { en } from './en';
import { pt, type Textos } from './pt';

/**
 * Idiomas do site: português na raiz (`/`) e inglês em `/en/`. O idioma de
 * origem é o português; o en.ts tem o mesmo formato do pt.ts, então o
 * TypeScript acusa qualquer texto que falte.
 */
export type Lang = 'pt' | 'en';

export const LANGS: readonly Lang[] = ['pt', 'en'];

const TEXTOS: Record<Lang, Textos> = { pt, en };

export function textos(lang: Lang): Textos {
  return TEXTOS[lang];
}

export function outroIdioma(lang: Lang): Lang {
  return lang === 'pt' ? 'en' : 'pt';
}

/** Idioma de uma página, pelo endereço: `/en/...` é inglês, o resto é português. */
export function langDaUrl(url: URL): Lang {
  return url.pathname === '/en' || url.pathname.startsWith('/en/') ? 'en' : 'pt';
}

/** Idioma da página aberta, para os scripts do navegador. */
export function langDoDocumento(): Lang {
  return document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'pt';
}

/** Rota interna no idioma: `/docs/` vira `/en/docs/` em inglês. */
export function rota(lang: Lang, caminho: string): string {
  if (lang === 'pt') return caminho;
  if (caminho === '/') return '/en/';
  if (caminho.startsWith('/#')) return `/en/${caminho.slice(1)}`;
  return `/en${caminho}`;
}

/** O caminho sem o prefixo de idioma, para achar a mesma página no outro. */
export function semIdioma(caminho: string): string {
  if (caminho === '/en' || caminho === '/en/') return '/';
  return caminho.startsWith('/en/') ? caminho.slice(3) : caminho;
}

/** Os dois idiomas como rotas estáticas (`/` em português e `/en/` em inglês). */
export function caminhosPorIdioma(): { params: { lang: string | undefined } }[] {
  return [{ params: { lang: undefined } }, { params: { lang: 'en' } }];
}

/** Pasta das imagens e vídeos do filme no idioma: as telas da IDE têm a interface gravada. */
export function pastaFilme(lang: Lang): string {
  return lang === 'en' ? '/filme/en' : '/filme';
}
