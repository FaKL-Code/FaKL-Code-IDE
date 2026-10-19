# 0053. Cozinha do CI em tela própria, com as saídas do café e da Mesa

- Status: aceita
- Data: 2026-10-19
- Requisitos: RF-607; ADR 0051 (substitui a parte "a cozinha fica no painel do café")

## Contexto

A ADR 0051 pôs a cozinha do CI abaixo da sala do café. Na prática ela disputa o espaço com os
agentes, e, diferente do café (onde o agente que termina sai) e da Mesa (onde **Limpar
encerrados** tira o que acabou), a cozinha acumulava execuções velhas: só saíam as terminadas há
mais de 6 horas, e não havia como tirar uma à mão.

## Decisão

- **Tela própria.** O painel `fakl.ci` ("Cozinha do CI") tem a bancada, os cartões e a lista
  escondida de acessibilidade. Comandos: **FaKL: Abrir a cozinha do CI** (`fakl.ci.open`) e
  **Cozinha do CI em outra janela** (`fakl.janela.cozinha`, outro monitor). O item do CI na barra de
  status abre essa tela. O café perde a cozinha e ganha o botão **Cozinha do CI**.
- **Mesmas saídas do café e da Mesa.** Dispensar uma execução (x no cartão), **Limpar concluídas**
  (tudo o que terminou), **Mostrar as removidas** e saída automática: sucesso e cancelada saem
  sozinhas depois de `fakl.ci.concluidasSaemApos` minutos (padrão 15; 0 desliga). Falha não sai
  sozinha, porque é o que pede atenção; some ao ser dispensada ou quando chega uma execução mais
  nova do mesmo fluxo (regra que já existia).
- **Onde mora o estado.** A regra é `Descarte` (`packages/cafe/src/cozinha-descarte.ts`, só
  lógica, testada). Dispensar guarda `{ execução: estado }`: se o estado muda, a execução volta. O
  webview guarda isso em `getState/setState`, então sobrevive a esconder e reabrir o painel. O Core
  não sabe de nada disso: continua só lendo o GitHub, e os placares seguem contando tudo o que ele leu.
- **Filtro antes do corte.** `mountKitchen` ganhou a opção `filter`, aplicada antes do limite de 8
  bancadas, para uma execução dispensada ceder o lugar à próxima em vez de deixar a bancada vazia.
  Sem `filter`, o comportamento é o de antes (o app do celular segue assim).

## Consequências

- O que foi tirado volta se a IDE reiniciar por completo (o estado do webview não é do disco).
  Aceito: é uma conveniência de tela, não um registro.
- O app do celular continua com a cozinha na aba Café, somente leitura e sem as saídas. Levar as
  saídas ao celular exigiria estado no Core (o celular não escolhe nada, ADR 0044); fica para depois.
- `cafe.state` segue levando o campo `ci`, e o café deixou de usá-lo; o campo é o que o celular lê.
- Não houve teste numa IDE compilada: a tela foi conferida por tipos, testes da lógica e build.
