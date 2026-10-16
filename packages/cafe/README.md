# @fakl/cafe

A sala do cyber café (SDD 13, ADR 0011): sala isométrica em pixel art no estilo
dos hotéis virtuais, montada em Canvas 2D num quadro de 1x e ampliada sem
suavizar. Bar com barista, mesas com os monitores mostrando o que cada agente
faz, fliperama, jukebox, sinuca, sofá, bebedouro, gato, janelas com céu e luz
que seguem a hora do dia. Só desenha e anima; quem hospeda entrega
`cafe.state` e os eventos do Core.

- `mountCafe({ canvas, onOpen, onRefresh, onChange, assets })` monta a sala num
  canvas e devolve `applyState`, `onEvent`, `setOffline`, `seats`, `pause`,
  `resume` e `setHour`.
- O painel da IDE (`extensions/fakl-core/src/webview/cafe.ts`) e o app do
  celular (`apps/remote-pwa`) usam a mesma sala.
- **Sprites:** cada peça é um PNG em `assets/` com nome e tamanho fixos (veja
  `assets/README.md`). Enquanto o PNG não existe, entra o desenho provisório de
  `src/art/`. A extensão copia os PNGs para o webview no build.
- **Prévia:** `pnpm --filter @fakl/cafe preview` abre a sala com agentes de
  mentira em <http://localhost:8123/preview/dist/?assets=../../assets/>, com
  controle da hora e botões para criar, concluir e falhar agentes.
