# 0032. Modo minimizado: overlay dos agentes no processo principal

- Status: aceita
- Data: 2026-10-15
- Requisitos: RF-109; complementa as ADRs 0005, 0006 e 0023

## Contexto

Quem deixa agentes trabalhando enquanto faz outra coisa perde tempo de agente
toda vez que um deles para esperando permissão, decisão ou troca de conta, e
só percebe ao voltar para a IDE. A notificação nativa (ADR 0006) avisa, mas
não deixa responder; o app do celular (ADR 0023) responde, mas pede outro
aparelho. O pedido foi um modo minimizado, no estilo do "pet" do Codex: uma
janela pequena por cima de tudo para acompanhar os agentes, responder,
mandar tarefas e trocar de conta sem a IDE inteira aberta. O desenho das
telas está em [docs/ux/modo-minimizado.md](../ux/modo-minimizado.md).

Uma extensão não resolve: as webviews vivem dentro da janela da IDE, que é
justamente o que se quer tirar da frente, e o host de extensões morre quando
a última janela fecha.

## Decisão

- **Janela do processo principal.** Um patch novo,
  `patches/fakl-overlay.patch`, cria `faklOverlay.ts` no processo principal:
  uma `BrowserWindow` sem moldura, transparente, sempre no topo e fora da
  barra de tarefas, com duas formas (pet e painel), posição lembrada no
  `userData`, um ícone na bandeja e um atalho global. `faklCore.ts` passa ao
  overlay o endereço do Core (mensagem `ready`) e o token que ele já gera.
- **Página local, sem acesso ao Node.** O overlay é um app web próprio,
  `apps/overlay`, montado em `extensions/fakl-core/dist/overlay/`, com
  `contextIsolation` e `sandbox`. O preload só expõe `window.faklOverlay`
  (contrato no documento de UX). O token nunca chega à página: o processo
  principal conecta ao socket do Core, faz o `session.hello` e repassa as
  linhas JSON-RPC.
- **O Core continua sendo o centro.** O overlay usa a mesma API que o
  celular (`agents.*`, `tasks.*`, decisões, permissões, uso, contas do
  Claude). Os pedidos que precisam da janela da IDE passam pelo Core:
  `ui.reveal` (traz a IDE, e a extensão abre a conversa) e `ui.overlay` (a
  extensão pede o modo minimizado). O Core repassa ao processo principal pelo
  `parentPort` (`ToHost`), como nas notificações.
- **Minimizar esconde, não fecha.** Entrar no modo minimizado esconde as
  janelas da IDE; o host de extensões e o estado das telas continuam.
  Fechar a última janela com o overlay aberto também não encerra o
  aplicativo: no Windows e no Linux o `lifecycleMainService` trataria isso
  como saída, então o patch faz ele se comportar como no macOS enquanto o
  overlay está aberto (`setFaklKeepAlive`); a janela fecha de verdade, o Core
  e os agentes seguem, e a bandeja dá o caminho de volta ou de saída, que
  segue o diálogo da ADR 0006. O overlay só fecha quando a saída é
  confirmada (`onWillShutdown`).

## Consequências

- Mais um patch no Code-OSS: um arquivo novo, duas chamadas em `faklCore.ts`
  e duas condições no `lifecycleMainService.ts`.
- O overlay não é testado dentro do Electron no CI; o app tem testes de
  unidade do modelo e uma prévia com um Core de mentira
  (`pnpm --filter @fakl/overlay preview`), como o app do celular.
- Com a IDE fechada e o overlay aberto, o processo do Electron continua com
  o Core e os agentes; a memória do workbench é liberada só se a janela for
  fechada, não escondida.

## Alternativas consideradas

- **Reaproveitar o app do celular numa janela.** Ele fala com o relay
  cifrado e é desenhado para tela de telefone; trocar o transporte dele e
  espremer as cinco abas num pet custaria mais que um app pequeno que reusa
  `@fakl/protocol` e `@fakl/conversa`.
- **Expor o Core por WebSocket local para a página.** Abriria uma porta TCP
  para qualquer processo da máquina e obrigaria o token a chegar à página.
- **Webview flutuante dentro da IDE.** Some junto com a janela da IDE.
