# 0046. Terminal ao vivo, somente leitura, por agente

- Status: aceita
- Data: 2026-10-18
- Requisitos: RF-105, RF-106; SDD 8.4

## Contexto

O SDD (8.4) previa um PTY por sessão e um buffer headless de 10.000 linhas, e o RF-106 pede
que a Mesa mostre o terminal de cada agente. Na prática não existe PTY: os agentes falam ACP
(JSON-RPC sobre stdio), que não é um terminal. O comando `fakl.agents.terminal` só abre um
shell comum na pasta onde o agente trabalha, sem nenhuma ligação com o que o agente está
fazendo. A Mesa mostra eventos e logs por cartão, mas não há um lugar onde se acompanhe,
num formato de terminal, o que um agente diz, que ferramentas chama e o que pede de
permissão. `agents.terminal.attach` existia só como nome em `methods.ts`, sem handler.

Trazer o `node-pty` resolveria o PTY, mas é um módulo nativo: compilar para o Electron da IDE
em três sistemas, a cada atualização do upstream, é um custo que o projeto não paga agora. E
mesmo com ele não haveria o que ligar: o agente ACP não escreve num terminal.

## Decisão

Entregar um terminal **de leitura**, ao vivo, sem PTY e sem módulo nativo.

- **Core.** `packages/core/src/agent-terminal.ts` (`AgentTerminals`) assina os eventos que o
  `AgentRuntime` já publica (`agent.output`, `agent.tool`, `agent.permission`, `agent.answer`,
  `agent.state`, `agent.prompt`, `agent.file`) e os transforma em linhas de terminal com cores
  ANSI simples (cinza para pensamento, vermelho para erro, ciano para ferramenta, amarelo para
  pedido de permissão, verde para decisão e prompt, azul para estado). Cada sessão tem um
  buffer circular de 10.000 linhas (`TERMINAL_MAX_LINES`), cada linha com um `seq` crescente.
  - Os pedaços de saída do agente são juntados em linhas; o que ainda não fechou com quebra
    de linha sai quando chega outro evento ou quando alguém anexa.
  - O texto passa pelo `redact` de segredos do Core **depois** de montada a linha, para um
    segredo cortado entre dois pedaços não escapar. Escapes ANSI e caracteres de controle
    vindos do agente são removidos antes de pintar: só o Core coloca cor.
  - Chamadas de ferramenta mostram só o título (curto) e o status, e só quando algo muda;
    pedidos de permissão mostram o título e até 8 linhas de argumentos, cada uma encurtada.
- **API.** `agents.terminal.attach` devolve `{ lines, state, dropped }` com o histórico do
  buffer e passa a enviar as linhas novas à conexão como notificações
  `agents.terminal.lines`, até `agents.terminal.detach` ou o fim da conexão. Vários clientes
  podem anexar à mesma sessão; anexar duas vezes não duplica a entrega. Sessão encerrada
  continua com o histórico (e `state` final); sessão que não existe é `NotFound`. Apagar a
  sessão (`agents.forget`) apaga o buffer. O método não entra nos escopos do controle
  remoto: o celular tem o chat e o histórico da conversa.
- **Extensão `fakl-core`.** Um `vscode.Pseudoterminal` por agente, na aba "Terminal: <nome>",
  mostra o histórico e as linhas novas. É somente leitura: as teclas são ignoradas e a
  primeira linha avisa isso. O comando novo `fakl.agents.liveTerminal` abre (ou traz para a
  frente) o terminal do agente a partir da paleta, do menu de contexto da lista de agentes e
  do botão "Terminal" no cartão da Mesa (e do menu do cartão). `fakl.agents.terminal` segue
  como estava: o shell na pasta do agente. Depois de uma reconexão ao Core, o terminal anexa
  de novo e escreve só o que faltava (o `seq` evita repetição; se o Core reiniciou e a
  numeração voltou, escreve tudo).

## O que fica para um adaptador PTY de verdade

- **Interatividade.** Digitar no agente por um terminal exige um adaptador que lance a CLI
  num PTY (RF-103, "qualquer CLI de terminal"), em vez de ACP. Aí o PTY existiria, a entrada
  das teclas seria repassada e o `node-pty` (ou uma alternativa sem módulo nativo, como o
  `ConPTY`/`forkpty` por um processo auxiliar já compilado) voltaria a ser a pergunta.
- **Saída bruta de comandos.** Hoje o terminal não mostra a saída de um comando que o agente
  roda (o ACP só informa título e status da ferramenta, a saída vai ao agente). Um adaptador
  PTY a mostraria como ela é, com cores e redesenho de tela.
- **Miniaturas e `@xterm/headless`.** O buffer de terminal que o SDD descrevia para
  miniaturas continua sendo só texto; renderizar tela exigiria o emulador.
- **Histórico em disco.** O buffer vive na memória do Core: depois de reiniciar a IDE o
  terminal de uma sessão antiga começa vazio (a conversa continua no chat, ADR 0022).

## Consequências

- O RF-106 passa a ter o terminal por agente, de leitura; o RF-105 ("terminal próprio")
  fica atendido no sentido de leitura: cada agente tem o seu, mas não há PTY.
- Custo de memória: até 10.000 linhas de, no máximo, 2.000 caracteres por sessão no Core.
- Nada é gravado em disco e nenhum segredo conhecido do Core aparece nas linhas.
- A saída de linhas ainda abertas chega no próximo evento da sessão (fim de turno, ferramenta,
  permissão), não a cada caractere; é o preço de só publicar linhas inteiras.
- Não houve teste na IDE compilada: a parte visual (aba, cores, botão da Mesa) foi conferida
  só por tipos e pelos testes do modelo; ver o PR.
