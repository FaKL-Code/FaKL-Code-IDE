# 0035. Site da IDE em Astro, com o filme de lançamento guiado por rolagem

- Status: aceita
- Data: 2026-10-15
- Requisitos: pedido dos mantenedores de 2026-10-15; spec da landing page (PR #68)

## Contexto

A IDE precisa de um site de divulgação, documentação e download. A primeira
tentativa, gerada na Lovable, não ficou boa. A spec pede movimento de filme de
lançamento ligado à rolagem, telas fiéis ao produto e tudo legível sem
animação, no celular e com movimento reduzido.

## Decisão

O site fica em `apps/landing`, feito com Astro em saída estática. O movimento
usa GSAP com ScrollTrigger e a rolagem suave usa Lenis.

A página é montada como uma composição do HyperFrames, a ferramenta do filme de
lançamento: cada seção é um clipe com início e duração no tempo do filme. As
cenas do vídeo foram portadas para componentes Astro, nos cortes 16:9 e 9:16, e
um palco preso na tela troca de seção com uma transição em grade de pixels (a
mesma linguagem do filme), enquanto o player passa para o monitor seguinte. As legendas do filme viram o texto das seções, digitado no
mesmo tempo. Na abertura, a palavra JUNTOS. é montada em pixels
gigantes por três cursores (Claude, Codex e Gemini) trabalhando em paralelo. O cyber café é o `@fakl/cafe` de verdade,
rodando ao vivo. Depois do filme, os recursos aparecem como créditos, com links
para a documentação.

## Consequências

- O site sai em HTML pronto, bom para SEO e para hospedar em qualquer lugar
  estático. O endereço público entra no build por `PUBLIC_SITE_URL`.
- As cenas acompanham o filme: quando o vídeo mudar, as cenas e as imagens em
  `public/filme/` são portadas de novo a partir do projeto do vídeo.
- Com movimento reduzido, a página mostra o quadro final sem prender a rolagem.
- O filme não vai para o git; o build recebe o endereço em `PUBLIC_FILME`.
- Downloads ficam como "Em breve" até existirem instaladores públicos.

## Alternativas consideradas

- **Lovable:** gera rápido, mas o resultado não chegou ao nível pedido e as
  telas seriam inventadas.
- **Next.js ou Vite com React:** mais peso de JavaScript para um site de
  conteúdo, sem ganho para a documentação.
- **3D com WebGL:** a spec pede um site leve, que funcione sem GPU dedicada.
