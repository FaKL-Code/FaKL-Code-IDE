# Site da FaKL-Code IDE

Landing page, documentação pública e página de download, em Astro estático.
Decisão na [ADR 0035](../../docs/adr/0035-site-da-ide-em-astro.md); conteúdo e
movimento seguem a [spec da landing](../../docs/superpowers/specs/2026-10-15-landing-page-fakl-code-design.md).

```sh
pnpm --filter @fakl/landing dev       # http://localhost:4321
pnpm --filter @fakl/landing build     # dist/
```

- `src/config/site.ts`: endereço, downloads e filme.
- `src/i18n/`: os textos do site em português (`pt.ts`, o idioma de origem) e em
  inglês (`en.ts`, mesmo formato: o TypeScript acusa o texto que faltar). O
  português fica na raiz (`/`) e o inglês em `/en/`; as páginas ficam em
  `src/pages/[...lang]/`. O link PT/EN do menu leva à mesma página no outro
  idioma, e o `hreflang` e o sitemap apontam o par.
- `src/content/docs/` (português) e `src/content/docs-en/` (inglês): páginas da
  documentação em Markdown, com os mesmos nomes de arquivo nos dois idiomas.
- `src/filme/roteiro.ts`: a página como composição HyperFrames. Cada seção é
  um clipe com início e duração no tempo do filme, e as legendas viram os
  passos de texto da seção.
- `src/components/filme/`: as cenas do filme em `h/` (16:9) e `v/` (9:16),
  portadas do projeto do vídeo; `Player.astro` (o player único) e `Clipe.astro`
  (uma seção com monitor). O café usa quadros parados da sala ao vivo.
- `src/filme/`: as timelines GSAP de cada cena; `filme.ts` põe o player sobre o
  monitor da seção da vez, voa entre monitores e liga o tempo à rolagem;
  `sala.ts` é o cyber café ao vivo (`@fakl/cafe`).
- `public/filme/`: imagens e vídeos curtos das cenas, tirados das renderizações
  do projeto do vídeo. As telas da IDE têm a interface gravada na imagem, então
  `public/filme/en/` guarda as mesmas telas e vídeos em inglês (capturados com
  o idioma em inglês e dados de exemplo em inglês); `pastaFilme` em `src/i18n`
  escolhe a pasta. Os vídeos têm WebM e MP4 com keyframe a cada 6 quadros
  para a rolagem poder andar neles.
- `src/scripts/landing.ts`: liga Lenis, o filme e as revelações da página.

Para o botão "Assistir ao filme", passe o endereço do MP4 no build:
`PUBLIC_FILME=https://.../filme.mp4 pnpm --filter @fakl/landing build`.
