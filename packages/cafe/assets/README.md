# Sprites do cyber café

Os PNGs desta pasta substituem os desenhos provisórios de `src/art/`. Cada
arquivo tem nome, tamanho e âncora fixos (tabela abaixo, gerada do código).
Basta salvar o PNG aqui, no caminho exato, e a sala passa a usá-lo; nenhuma
linha de código muda. Um arquivo com tamanho diferente é ignorado com um aviso
no console, e o provisório continua.

- **Prompts e critérios:** `marca/assets-pendentes.md` do projeto, grupos G a J.
- **Conferir:** `pnpm --filter @fakl/cafe preview` abre a sala com agentes de
  mentira em `http://localhost:8123/preview/dist/?assets=../../assets/`.
- **Folhas:** quadros lado a lado, sem espaço, da esquerda para a direita; uma
  linha por direção quando houver.
- **Âncora:** o pixel do quadro que cai no ponto da cena. Nos móveis é o canto
  de trás do chão (o vértice de cima do losango); nos agentes, o pé em (16, 46);
  nas paredes, o pé da parede no começo do ladrilho.
- **Áreas vazadas:** a tela do monitor e o vidro da janela ficam transparentes e
  cercados por pixels opacos. A sala acha esse buraco sozinha e desenha a
  miniatura do agente e o céu por trás.
- **Agentes:** pintados nas cores-chave (camisa `#d97757`/`#a8553a`, pele
  `#e0ac69`/`#c68642`, cabelo `#4a2f1b`/`#2b1d14`), trocadas em código pela cor
  do provedor e pela pele e cabelo de cada agente.

| Arquivo                            | Folha (px) | Quadro (px) | Quadros x linhas | Âncora (x, y) |
| ---------------------------------- | ---------- | ----------- | ---------------- | ------------- |
| `tiles/wall-back.png`              | 16x80      | 16x80       | 1 x 1            | (0, 72)       |
| `tiles/wall-left.png`              | 16x80      | 16x80       | 1 x 1            | (16, 72)      |
| `tiles/wall-left-window.png`       | 32x88      | 32x88       | 1 x 1            | (32, 72)      |
| `tiles/wall-left-door.png`         | 32x88      | 32x88       | 1 x 1            | (32, 72)      |
| `tiles/wall-left-door-open.png`    | 32x88      | 32x88       | 1 x 1            | (32, 72)      |
| `tiles/floor-a.png`                | 32x16      | 32x16       | 1 x 1            | (16, 0)       |
| `tiles/floor-b.png`                | 32x16      | 32x16       | 1 x 1            | (16, 0)       |
| `tiles/floor-carpet.png`           | 32x16      | 32x16       | 1 x 1            | (16, 0)       |
| `tiles/floor-wood.png`             | 32x16      | 32x16       | 1 x 1            | (16, 0)       |
| `tiles/floor-edge-left.png`        | 16x14      | 16x14       | 1 x 1            | (0, 0)        |
| `tiles/floor-edge-right.png`       | 16x14      | 16x14       | 1 x 1            | (16, 0)       |
| `props/desk.png`                   | 39x37      | 39x37       | 1 x 1            | (12, 17)      |
| `props/monitor-front.png`          | 27x32      | 27x32       | 1 x 1            | (12, 28)      |
| `props/chair.png`                  | 72x38      | 18x38       | 4 x 1            | (9, 29)       |
| `props/water-cooler.png`           | 88x56      | 22x56       | 4 x 1            | (11, 45)      |
| `props/bar-counter.png`            | 66x60      | 66x60       | 1 x 1            | (11, 27)      |
| `props/bar-shelf.png`              | 46x72      | 46x72       | 1 x 1            | (7, 49)       |
| `props/espresso.png`               | 36x34      | 18x34       | 2 x 1            | (7, 25)       |
| `props/bar-stool.png`              | 15x25      | 15x25       | 1 x 1            | (7, 17)       |
| `props/arcade.png`                 | 100x64     | 25x64       | 4 x 1            | (11, 51)      |
| `props/jukebox.png`                | 92x51      | 23x51       | 4 x 1            | (9, 39)       |
| `props/pool-table.png`             | 57x44      | 57x44       | 1 x 1            | (20, 15)      |
| `props/sofa.png`                   | 47x47      | 47x47       | 1 x 1            | (14, 23)      |
| `props/coffee-table.png`           | 28x27      | 28x27       | 1 x 1            | (11, 13)      |
| `props/rug.png`                    | 105x56     | 105x56      | 1 x 1            | (39, 3)       |
| `props/floor-lamp.png`             | 14x56      | 14x56       | 1 x 1            | (7, 49)       |
| `props/plant-tall.png`             | 18x56      | 18x56       | 1 x 1            | (9, 47)       |
| `props/plant-small.png`            | 15x33      | 15x33       | 1 x 1            | (7, 25)       |
| `props/wall-clock.png`             | 17x19      | 17x19       | 1 x 1            | (8, 9)        |
| `props/scoreboard.png`             | 50x54      | 50x54       | 1 x 1            | (1, 28)       |
| `props/menu-board.png`             | 40x42      | 40x42       | 1 x 1            | (1, 23)       |
| `props/neon-sign.png`              | 48x31      | 24x31       | 2 x 1            | (1, 19)       |
| `props/poster.png`                 | 28x35      | 28x35       | 1 x 1            | (8, 30)       |
| `props/trophy-five-agents.png`     | 10x12      | 10x12       | 1 x 1            | (5, 11)       |
| `props/trophy-hundred-prs.png`     | 10x12      | 10x12       | 1 x 1            | (5, 11)       |
| `props/trophy-locked.png`          | 10x12      | 10x12       | 1 x 1            | (5, 11)       |
| `props/smoke.png`                  | 48x20      | 12x20       | 4 x 1            | (6, 19)       |
| `props/steam.png`                  | 18x10      | 6x10        | 3 x 1            | (3, 9)        |
| `props/pool-balls.png`             | 9x3        | 3x3         | 3 x 1            | (1, 2)        |
| `sky/skyline.png`                  | 80x56      | 40x56       | 2 x 1            | (0, 56)       |
| `sky/sun.png`                      | 9x9        | 9x9         | 1 x 1            | (4, 4)        |
| `sky/moon.png`                     | 9x9        | 9x9         | 1 x 1            | (4, 4)        |
| `agents/agent-walk.png`            | 128x192    | 32x48       | 4 x 4            | (16, 46)      |
| `agents/agent-sit-typing.png`      | 96x48      | 32x48       | 3 x 1            | (16, 46)      |
| `agents/agent-sit-idle.png`        | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-sit-thinking.png`    | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-sit-hand-up.png`     | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-sit-scratch.png`     | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-sit-paused.png`      | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-sit-sleep.png`       | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-sit-stretch.png`     | 128x48     | 32x48       | 4 x 1            | (16, 46)      |
| `agents/agent-celebrate.png`       | 128x48     | 32x48       | 4 x 1            | (16, 46)      |
| `agents/agent-deliver.png`         | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-drink-water.png`     | 96x48      | 32x48       | 3 x 1            | (16, 46)      |
| `agents/agent-cooler-chat.png`     | 96x48      | 32x48       | 3 x 1            | (16, 46)      |
| `agents/agent-drink-coffee.png`    | 96x48      | 32x48       | 3 x 1            | (16, 46)      |
| `agents/agent-arcade.png`          | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-pool.png`            | 96x48      | 32x48       | 3 x 1            | (16, 46)      |
| `agents/agent-sofa-chat.png`       | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-sofa-sip.png`        | 64x48      | 32x48       | 2 x 1            | (16, 46)      |
| `agents/agent-maestro-headset.png` | 128x48     | 32x48       | 4 x 1            | (16, 46)      |
| `agents/npc-barista.png`           | 128x48     | 32x48       | 4 x 1            | (16, 46)      |
| `agents/cat.png`                   | 80x16      | 16x16       | 5 x 1            | (8, 15)       |
| `screens/screen-off.png`           | 21x15      | 21x15       | 1 x 1            | (0, 0)        |
| `screens/screen-boot.png`          | 84x15      | 21x15       | 4 x 1            | (0, 0)        |
| `screens/screen-saver.png`         | 84x15      | 21x15       | 4 x 1            | (0, 0)        |
| `screens/screen-error.png`         | 42x15      | 21x15       | 2 x 1            | (0, 0)        |
| `emotes/emote-thinking.png`        | 48x16      | 16x16       | 3 x 1            | (3, 15)       |
| `emotes/emote-alert.png`           | 32x16      | 16x16       | 2 x 1            | (3, 15)       |
| `emotes/emote-ok.png`              | 16x16      | 16x16       | 1 x 1            | (3, 15)       |
| `emotes/emote-error.png`           | 16x16      | 16x16       | 1 x 1            | (3, 15)       |
| `emotes/emote-coffee.png`          | 16x16      | 16x16       | 1 x 1            | (3, 15)       |
| `emotes/emote-water.png`           | 16x16      | 16x16       | 1 x 1            | (3, 15)       |
| `emotes/emote-idea.png`            | 16x16      | 16x16       | 1 x 1            | (3, 15)       |
| `emotes/emote-zzz.png`             | 48x16      | 16x16       | 3 x 1            | (3, 15)       |
| `emotes/emote-confetti.png`        | 48x16      | 16x16       | 3 x 1            | (3, 15)       |
| `emotes/emote-chat.png`            | 32x16      | 16x16       | 2 x 1            | (3, 15)       |
| `emotes/emote-music.png`           | 32x16      | 16x16       | 2 x 1            | (3, 15)       |
