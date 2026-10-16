# 0015. Marca Terminal

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-001 (marca FaKL-Code)

## Contexto

Os mantenedores aprovaram um brand kit novo, chamado "Terminal": um terminal em
perspectiva com o prompt `>_` ciano e brilho azul sobre fundo escuro, com
paleta própria e a tipografia Inter. Ele substitui o logo anterior: um "F"
entre chevrons, com faísca e degradê violeta e ciano.

O kit vem só em PNG, sem SVG. O recorte da transparência é aproximado, com
franjas escuras sobre fundo claro, e o símbolo em 3D vira uma mancha em 16 e
32 px.

## Decisão

- **Adotar a marca Terminal** em toda a IDE: ícones de macOS, Windows e Linux,
  ícones da web, imagens do instalador e marca d'água do editor vazio.
- **Redesenhar o símbolo em vetor** (`branding/logo/`) seguindo a arte
  aprovada: face escura com brilho no topo, espessura azul à direita, borda em
  degradê e o `>_` ciano com brilho. O pipeline de ícones que já existe gera
  tudo a partir dele, inclusive a marca monocromática do editor vazio.
- **Usar as peças raster do kit onde a nitidez em tamanho pequeno não pesa:**
  o banner do README, a prévia social e a vitrine em `docs/marca/`.
- **Instalador do Windows:** degradê do fundo `#0D1117` ao azul primário
  `#2563EB`.

## Consequências

- O ícone fica nítido em 16 px e sem franjas em qualquer fundo.
- O vetor é uma reinterpretação da arte 3D, não uma cópia exata dela. Se
  surgir um SVG mestre do designer, basta trocar `branding/logo/` e rodar
  `pnpm --filter @fakl/branding icons`.
- O app do celular usa o mesmo logo, mas mantém a sua paleta escura atual.
