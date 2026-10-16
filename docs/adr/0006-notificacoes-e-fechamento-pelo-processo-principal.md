# 0006. Notificações nativas e fechamento com agentes pelo processo principal

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-109, RF-110; SDD 6.1

## Contexto

Quem trabalha com vários agentes deixa a IDE em segundo plano e precisa saber
quando um agente termina, falha ou pede decisão (RF-109). Ao fechar a IDE com
agentes no meio de um trabalho, o usuário escolhe entre esperar e parar
(RF-110). Uma extensão não resolve nenhum dos dois: as notificações dela só
aparecem dentro da janela, e o host de extensões já foi encerrado quando o
fechamento chega ao fim.

## Decisão

- O Core e o processo principal conversam pelo `parentPort` do
  `utilityProcess`, que já existe pela ADR 0005. As mensagens estão em
  `packages/core/src/host.ts` (`ToHost` e `FromHost`). O Core decide o que
  notificar; o processo principal só mostra.
- Notificação do sistema (`Notification` do Electron) apenas quando nenhuma
  janela da IDE está em foco. Com a IDE em foco, quem avisa é a extensão,
  dentro da janela. Clicar na notificação traz a IDE para a frente.
  Notificam: fim de vez de um agente, conclusão, falha, parada por limite e
  pedido de permissão.
- No `onWillShutdown`, o processo principal pergunta ao Core quem está
  trabalhando (`query-busy`). Agentes ociosos não contam. Se houver alguém,
  um diálogo oferece "Esperar terminar" e "Parar agora". Esperar mantém o Core
  vivo com as janelas já fechadas até ele avisar `idle`; nesse meio tempo, os
  pedidos de permissão viram diálogos nativos. Parar segue o encerramento da
  ADR 0005, com o prazo subindo de 2 s para 15 s, para dar tempo de guardar o
  trabalho dos agentes nos branches.
- O fechamento não pode ser cancelado nesse ponto: o `onWillShutdown` não
  aceita veto. As duas opções do RF-110 bastam.

## Consequências

- O patch continua a ser só `faklCore.ts` e duas linhas no `app.ts`.
- Esperar não tem limite de tempo próprio; valem os limites dos agentes (SDD
  9.4). Um agente travado mantém o processo vivo até o usuário encerrá-lo
  pelo gerenciador de tarefas.
