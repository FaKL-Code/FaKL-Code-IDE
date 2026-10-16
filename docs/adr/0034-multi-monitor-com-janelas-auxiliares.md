# 0034. Multi-monitor com as janelas auxiliares do VS Code

- Status: aceita
- Data: 2026-10-15
- Requisitos: pedido dos mantenedores de 2026-10-15; complementa as ADRs 0017 e 0025

## Contexto

Com dois ou mais monitores, a IDE inteira ficava num só: a Mesa, o chat dos
agentes e o café disputavam espaço com o código. O pedido foi poder mover
partes da IDE para outros monitores, sem ter tudo na mesma janela.

O Code-OSS 1.135 já tem janelas auxiliares: um editor ou um grupo de
editores vai para uma janela própria (`workbench.action.moveEditorToNewWindow`,
arrastar a aba para fora da janela), no mesmo processo, com o mesmo estado e
restaurada no mesmo lugar ao reabrir. Só editores vão para essas janelas; as
views das barras laterais e do painel ficam na principal. Abrir uma segunda
janela da IDE (`Nova janela`) não serve: é outro workbench, com outro host de
extensões e outra conexão ao Core.

## Decisão

- **Usar as janelas auxiliares, sem patch no core.** Tudo o que deve ir para
  outro monitor vira editor e usa os comandos do VS Code.
- **Mesa e café** já são painéis de webview (editores). Ganham os comandos
  `FaKL: Mesa em outra janela` e `FaKL: Cyber café em outra janela`, que abrem
  o painel e o movem para uma janela nova.
- **Chat dos agentes.** É uma view da barra secundária, que não sai da janela
  principal. Ganha uma segunda forma, um painel de webview
  (`fakl.chatJanela`), aberto por `FaKL: Chat dos agentes em outra janela` ou
  pelo botão no topo do chat. As duas formas mostram a mesma conversa; com a
  janela aberta, `fakl.chat.open` e os pedidos que levam ao chat a mostram em
  vez da barra.
- **Volta ao reabrir.** Mesa, café e a janela do chat registram um
  `WebviewPanelSerializer` (e o evento de ativação `onWebviewPanel:`), então
  o VS Code os restaura na janela e no monitor onde estavam. Uma Mesa
  restaurada substitui a que `mesa.abrirAoIniciar` abre na janela principal.
- **Atalhos para o resto.** `FaKL: Editor atual em outra janela`,
  `Grupo de editores em outra janela`, `Terminal em outra janela` (move o
  terminal ativo ou cria um), `Nova janela vazia` e
  `Trazer de volta para a janela principal`. Os painéis do FaKL têm no topo um
  botão para ir para outra janela e, já numa janela auxiliar, um para voltar.

## Consequências

- Nenhum patch novo; o recurso acompanha as atualizações do Code-OSS.
- As árvores das barras laterais (Agentes, Tarefas, GitHub, Servidores) não
  vão para outro monitor. A Mesa cobre agentes e tarefas; quem precisar de
  outra pode abrir o conteúdo como editor quando houver.
- O chat na janela própria e na barra dividem a conversa selecionada.
