// @ts-check
import { defineConfig } from 'astro/config';

// Site estático: cada página sai em HTML pronto, sem servidor.
// O endereço público vem de PUBLIC_SITE_URL no build de publicação; o
// repositório não guarda o domínio de ninguém.
export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? 'https://exemplo.com',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  // Português na raiz (`/`) e inglês em `/en/`: as rotas ficam em
  // src/pages/[...lang] e os textos em src/i18n.
  i18n: {
    locales: ['pt', 'en'],
    defaultLocale: 'pt',
    routing: { prefixDefaultLocale: false },
  },
  // Sem otimização de imagem: as telas já saem em WebP do capturador, e o
  // sharp precisaria de script de instalação (o workspace não libera).
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
  devToolbar: { enabled: false },
});
