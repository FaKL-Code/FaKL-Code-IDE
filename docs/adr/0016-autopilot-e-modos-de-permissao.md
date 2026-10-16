# 0016. Autopilot e modos de permissão

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-106, RF-107, RF-206

## Contexto

Até aqui, o modo de permissão dos agentes era uma chave global
`permissoes` no `config.yaml`, com três valores: perguntar, aprovar-leitura e
aprovar-tudo. Ela não aparecia em nenhuma tela. O chat sempre abria o agente em
`perguntar`. Mesmo com `aprovar-tudo`, uma execução parava esperando você
quando o maestro parava ou um limite estourava.

Pediu-se um modo autopilot e a escolha do modo na interface, por agente e
por tarefa.

## Decisão

Os modos passam a ser quatro: `perguntar`, `aprovar-leitura`, `aprovar-tudo` e
`autopilot`. O modo de uma sessão é o primeiro que existir nesta ordem:

1. o escolhido ao iniciar (chat, tarefa, CLI ou celular);
2. o `permissoes` do perfil;
3. o `permissoes` do `config.yaml`.

O modo muda com o agente rodando, por `agents.setPermissions`: pelo seletor no
chat, por `fakl modo <sessão> <modo>` ou pelo celular, no escopo `comandar`.
Quando o modo novo aprova tudo, os pedidos do agente que estavam esperando são
liberados na hora.

Para o agente, o autopilot é igual a aprovar tudo. A diferença está no que a
IDE faz sozinha:

- No chat, com o agente num worktree, a sua pasta não muda. O trabalho fica no
  branch do agente e chega ao `main` por PR. Até 2026-10-13 o autopilot
  aplicava as mudanças na sua pasta ao fim de cada turno; veja a revisão
  abaixo.
- Numa execução, cada decisão é respondida pela opção segura e fica registrada
  com `origemResposta: autopilot`:
  - limite estourado: entregar como rascunho;
  - maestro parado: entregar como rascunho;
  - teto diário: deixar pausada;
  - possível segredo no diff: não enviar;
  - `ask_human` do maestro: a primeira opção, que o maestro deve pôr como a
    recomendada.
- O modo de uma execução é o da tarefa ou, se a tarefa não tiver um, o da
  sessão do maestro. Trocar o modo do maestro no chat muda a execução, e os
  subagentes novos herdam o modo.

Os pedidos de aprovação do próprio Core continuam esperando você, mesmo no
autopilot. São eles os comandos SSH, as ações na Hostinger e o envio de
segredos. São esses os pontos que mexem em servidores e contas fora da
máquina.

## Consequências

- O autopilot nunca faz push de um diff com cara de segredo. Ele nunca descarta
  trabalho: na dúvida, entrega como rascunho.
- Os eventos novos `agent.mode`, `agent.answer` e `agent.applied` mantêm o
  chat, a mesa de controle e o celular de acordo sobre o modo, os pedidos já
  respondidos em outro lugar e o que o autopilot aplicou.
- A lista de arquivos alterados do chat mostra só os pendentes. O painel some
  quando você aplica ou rejeita tudo.

## Revisão (2026-10-13): a pasta do usuário é só dele

Cada agente já trabalhava no próprio branch e abria PR. Mesmo assim, a cópia
da pessoa no `main` ficava suja, por dois motivos:

- o autopilot aplicava nela, a cada turno, o trabalho de todos os agentes,
  inclusive o que ainda não tinha virado PR;
- agentes mesclavam o próprio PR e depois rodavam `stash` e `pull` na pasta
  dele.

Com isso, o `git pull` do `main` nunca saía limpo.

A partir desta revisão:

- O autopilot não aplica mais nada na pasta do usuário. O evento
  `agent.applied` não é mais publicado, e as conversas antigas que o têm
  continuam abrindo.
- Todo agente num worktree recebe no prompt o caminho do worktree, o branch e
  a pasta do usuário. A regra diz que ele não edita essa pasta nem roda git nela
  e que não usa `git stash`, porque a pilha é compartilhada. Fora de uma tarefa,
  ele entrega por push e PR. Numa tarefa, quem entrega é a execução.
- Aplicar na pasta continua possível, mas só à mão, pelo botão do chat ou da
  Mesa.
