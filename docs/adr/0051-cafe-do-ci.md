# 0051. Café do CI: as execuções do GitHub Actions como a cozinha do cyber café

- Status: aceita
- Data: 2026-10-18
- Requisitos: RF-607 (novo); SDD 13.4; ADR 0045 (inventário de rede)

## Contexto

O cyber café mostra o que os agentes fazem. O que acontece depois do push (as execuções do
GitHub Actions) fica noutro lugar: o painel de Actions da IDE ou o navegador. Quem delega
trabalho a agentes olha para o CI o tempo todo e hoje precisa trocar de tela. A integração com
o GitHub do Core já lê execuções por repositório (`github.actions.list`, `recentRuns`), com
cache por ETag e controle do limite da API; falta quem acompanhe isso no tempo e o mostre.

Duas restrições vêm de decisões anteriores. A ADR 0045 diz que consulta automática da IDE
respeita o interruptor `fakl.rede.consultasAutomaticas` e entra no inventário de rede. E o
controle remoto do celular é só leitura no que não é conversa com o agente (ADR 0044, SDD 12.3).

## Decisão

Um serviço `ci` no Core acompanha poucos repositórios e publica o que muda; o café desenha uma
"cozinha" com isso. Não há integração nova com o GitHub: o serviço usa o `GitHubClient` que o
`GitHubService` já tem, com o mesmo token do cofre, que nunca passa pelo serviço nem é gravado
em log.

- **Quem é acompanhado.** O repositório do `origin` de cada pasta aberta na IDE e os repositórios
  marcados em `fakl.ci.repositorios`, no máximo 5 ao todo (`MAX_WATCHED_REPOS`), os abertos
  primeiro. O que passa do limite é descartado e a IDE avisa. Os marcados vivem na configuração
  da IDE; o Core guarda tudo só em memória.
- **Consulta com intervalo adaptativo** (`nextDelayMs`): 15 s com execução em andamento, na fila
  ou esperando aprovação; 45 s por 2 minutos depois de uma mudança; 5 minutos ocioso. Cada
  rodada de erros dobra o intervalo (teto de 15 minutos) e nunca se consulta antes de o limite
  da API voltar (`limitedUntil` do cliente). Por execução, só as 3 mais recentes têm os jobs
  lidos, e os jobs de uma execução terminada não são lidos de novo.
- **Interruptor e conta.** Nada é consultado sem a conta do GitHub conectada. A consulta
  automática só roda com `fakl.rede.consultasAutomaticas` ligada: a IDE entrega o valor ao Core
  em `ci.watch.set` (`automatico`) e de novo quando a configuração muda. O comando **FaKL:
  Atualizar o CI agora** (e `ci.status` com `atualizar`) consulta uma vez mesmo com o
  interruptor desligado, como as demais verificações por comando da ADR 0045. Pedidos seguidos
  em menos de 10 s são atendidos com o que já se sabe.
- **Protocolo.** `ci.status` (leitura) devolve o retrato: repositórios, execuções com jobs,
  fluxos falhando, execuções em andamento e "builds verdes seguidos". `ci.watch.set` define quem
  acompanhar. O evento `ci.run` sai quando uma execução aparece ou muda de estado (ou o estado
  de algum job), com deduplicação por assinatura; o retrato também vai em `cafe.state` (campo
  opcional `ci`, só quando há repositório acompanhado).
- **Escopos do controle remoto.** `ci.status` entra em `ver`, como `cafe.state`. `ci.watch.set`
  não entra em escopo nenhum: o celular vê a cozinha, não escolhe quem o Core consulta.
- **Estados.** O par `status`/`conclusion` do GitHub vira um de seis: fila, trabalhando,
  aguardando (aprovação), sucesso, falha, cancelada. `neutral` conta como sucesso; `skipped`,
  `stale` e `cancelled` como cancelada; `action_required` como aguardando; qualquer outra
  conclusão (inclusive uma que o GitHub invente) como falha, para o erro não passar por verde.
  "Falhando" é o fluxo (workflow no mesmo branch) cuja execução mais recente terminada falhou;
  uma execução seguinte que passa apaga a falha, uma cancelada ou em andamento não.
- **A cozinha** (`packages/cafe`). Uma bancada por execução (no máximo 8, a mais recente de
  cada fluxo, pedidos de atenção primeiro) com um cozinheiro e uma xícara por job. Trabalhando:
  mexe a colher e sobe vapor. Sucesso: comemora e toca o sino. Falha: mãos na cabeça, luz de
  alarme e fumaça. Aguardando: senhas na fila. Cancelada: bancada vazia, avental no gancho. O
  canvas é um quadro de 1x ampliado sem suavizar, no estilo do resto do café; os sprites são
  provisórios, desenhados em código (`art/cozinha.ts`), e um PNG de mesmo nome e tamanho em
  `assets/` os substitui. O placar da cozinha mostra builds verdes seguidos, fluxos falhando e
  execuções em andamento. A fonte de pixel só tem dígitos, então nome do workflow, branch,
  duração e jobs ficam nos cartões abaixo do canvas (a "miniatura" de cada execução).
- **Acessibilidade.** As execuções entram numa lista escondida com botões (Enter ou Espaço
  abre a execução) e os resultados vão para a mesma região `aria-live` dos agentes, agrupados
  numa frase (`RunAnnouncer` mais `AnnouncerGroup`): só resultado e espera por aprovação são
  anunciados, nunca "começou" nem "entrou na fila", e o primeiro retrato é só o ponto de
  partida. Com `prefers-reduced-motion` a bancada não alterna quadros.
- **IDE e celular.** O painel do café mostra a cozinha e os cartões quando há repositório
  acompanhado; clicar abre a execução no painel de Actions da IDE (`fakl.github.openRun`) ou,
  sem login, no navegador. A aba Café do celular mostra a mesma cozinha, somente leitura, e abre
  o GitHub no navegador do aparelho. Comandos: **Acompanhar o CI de um repositório** e
  **Atualizar o CI agora**; item na barra de status com o número de fluxos falhando.

## O que não faz

Não dispara, cancela nem reexecuta workflow, não lê logs, não escreve em repositório. Só leitura.
O painel de Actions da IDE continua sendo o lugar das ações (reexecutar, ver log do job).

## Consequências

- Uma consulta automática nova entra no inventário de rede (`docs/privacidade.md`):
  `api.github.com`, só com a conta conectada e repositórios escolhidos, coberta pelo interruptor.
- Custo da API: até 5 repositórios, 1 chamada de lista por rodada mais até 3 de jobs por
  repositório enquanto há execução ativa; ocioso, 5 chamadas a cada 5 minutos, quase todas
  respondidas como "não mudou" pelo ETag.
- "Builds verdes seguidos" vale para a janela lida (10 execuções por repositório), não para a
  história inteira do repositório.
- Os sprites são provisórios; a arte final por difusão pode entrar depois sem mexer em código.
- Não houve teste numa IDE compilada: a parte visual foi conferida por tipos e testes de lógica
  pura e de sprites; ver o PR.
