# 0011. Cyber café em Canvas 2D com arte desenhada em código

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-601 a RF-606; SDD 13

## Contexto

O SDD previa o café em PixiJS, com sprites isométricos. A sala tem poucas
dezenas de objetos (mesas, PCs, avatares e alguns móveis), roda a 30 fps só
quando está visível e não tem arte licenciada ainda. O Core precisa gerar as
miniaturas das telas só enquanto alguém olha a sala.

## Decisão

- **Canvas 2D no webview:** a sala é desenhada a cada quadro com a API 2D do
  navegador, em projeção isométrica 2:1 e ordenação por profundidade. Os
  avatares, móveis e monitores são pixel art feita com retângulos no próprio
  código, sem imagens nem dependências. O bundle fica em cerca de 17 KB.
- **Estado só no Core:** o webview guarda apenas a posição dos avatares. Ao
  abrir, quem está trabalhando já aparece sentado; quem chega depois entra pela
  porta. Fechar e reabrir não perde nada.
- **Miniaturas sob demanda:** `cafe.open` registra a conexão como espectadora
  e liga o timer de 2 s do Core, que publica `agent.thumbnail` só para
  sessões que mudaram. `cafe.close`, o painel escondido ou a conexão caindo
  desligam o timer. O painel não usa `retainContextWhenHidden`, então
  escondido ele não gasta CPU.
- **Miniatura legível fora da sala:** o monitor do PC mostra as linhas como
  barras coloridas (verde e vermelho para diff, barra de testes); a faixa de
  telas abaixo da sala mostra o mesmo texto legível. Clicar no avatar, no PC ou
  na tela abre a sessão no chat.
- **Placar e conquistas:** `cafe.state` traz tarefas concluídas, PRs e custo do
  dia, o maior número de agentes numa execução e o total de PRs; os troféus de
  5 agentes e 100 PRs aparecem no placar.

## Consequências

- Sem WebGL, o café funciona em qualquer máquina. A sala fica no pacote
  `@fakl/cafe`, usado pelo painel da IDE e pela aba Café do app do celular
  (RF-302), com os métodos `cafe.*` no escopo `ver` do controle remoto.
- Arte em código é mais simples de manter do que uma folha de sprites, mas
  limita o detalhe. Uma arte licenciada pode substituir as funções de desenho
  sem mudar o protocolo.
- **Atualização (2026-10-12):** a sala passou a ser feita de sprites. Cada peça
  é um PNG em `packages/cafe/assets/` com nome, tamanho e âncora fixos, e o
  desenho em código virou só o provisório de cada PNG que ainda não existe.
  Tudo é montado num quadro de 1x e ampliado em escala inteira, sem suavizar.
  Os agentes são uma folha só nas cores-chave, com a camisa, a pele e o cabelo
  trocados em código. A luz do dia e da noite é um mapa de luz multiplicado
  sobre a cena. Continua sem WebGL.
- O sino do `run.limit` usa WebAudio, que o navegador pode bloquear antes de um
  clique no painel; o relógio vermelho sempre aparece.

## Alternativas consideradas

- **PixiJS:** cerca de 500 KB a mais no bundle e um contexto WebGL por painel
  para uma cena pequena; ganharia só com centenas de sprites animados.
- **Miniatura como imagem gerada no Core:** exigiria uma biblioteca de imagem
  no Core e mais dados por evento; texto e cores bastam para o webview
  desenhar.
