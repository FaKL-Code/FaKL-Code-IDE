import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

import { site } from '../config/site';
import { rota } from '../i18n';

export const GET: APIRoute = async () => {
  const docs = await getCollection('docs');
  const caminhos = ['/', '/download/', '/docs/', ...docs.map((d) => `/docs/${d.id}/`)];
  const url = (caminho: string, lang: 'pt' | 'en'): string =>
    new URL(rota(lang, caminho), site.url).toString();
  // Cada página existe nos dois idiomas; cada entrada aponta para o par.
  const urls = caminhos.flatMap((c) =>
    (['pt', 'en'] as const).map(
      (lang) =>
        `  <url><loc>${url(c, lang)}</loc>` +
        `<xhtml:link rel="alternate" hreflang="pt" href="${url(c, 'pt')}"/>` +
        `<xhtml:link rel="alternate" hreflang="en" href="${url(c, 'en')}"/></url>`,
    ),
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'content-type': 'application/xml' } });
};
