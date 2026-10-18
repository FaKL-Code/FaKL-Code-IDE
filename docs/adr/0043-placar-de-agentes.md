# 0043. Placar de agentes por perfil

- Status: aceita
- Data: 2026-10-18
- Requisitos: RF-101, RF-201, RNF-13

## Contexto

A escolha do perfil de agente (qual modelo, qual provedor) é feita por intuição: o usuário
sente que um agente "rende mais", e o Maestro escolhe pelos `pontosFortes` e pelo
`custoRelativo` que alguém escreveu no YAML do perfil. O Core já vê tudo o que seria preciso
para dar dados a essa escolha, mas cada pedaço fica em um lugar: custos em `costs.jsonl`,
resultados das execuções em `runs/`, diffs aceitos e rejeitados só na chamada de
`agents.applyFiles` e `agents.rejectFiles` (sem registro), limites de uso só como estado
passageiro da sessão.

## Decisão

- Um módulo puro e testável, `packages/core/src/scorecard.ts`, agrega por perfil e por dia:
  sessões, tarefas concluídas, com falha e canceladas, duração, tokens e custo, arquivos
  aceitos e rejeitados no diff e vezes que o perfil bateu um limite de uso. Os períodos de 7
  e 30 dias e o total saem dessas somas.
- O módulo **assina o barramento de eventos** (`agent.state`, `cost.update`, `agent.review`,
  `agent.recovery`, `run.limit`, `run.done`) e não é chamado pelo `agents.ts`. A única mudança
  no `agents.ts` é publicar o evento novo `agent.review` quando o usuário aplica ou rejeita
  arquivos do diff, que antes não deixava rastro. A conta de tokens e custo reaproveita
  `usageDelta`, extraída do `CostTracker`, para os dois concordarem.
- Os contadores são incrementais e ficam em `~/.fakl/data/scorecard.json`: escrita atômica,
  arquivo corrompido vira placar vazio (o antigo fica ao lado, como `.corrompido`), histórico
  diário limitado a 90 dias e amostras de duração limitadas. O total não expira.
- Uma execução conta uma vez para cada perfil que participou dela. Concluída, falha e cancelada
  (execução descartada) vêm do estado final da execução; a duração desconta a espera pela
  renovação da cota do provedor.
- A taxa de aprovação é aceitos / (aceitos + rejeitados) dos arquivos do diff. Sem arquivo
  decidido, não há taxa, em vez de 0%.
- API: `scorecard.get` (com `periodo`) e `scorecard.reset`, CLI `fakl placar` e uma view em
  árvore "Placar dos agentes" na extensão `fakl-core`, com troca de período e zerar com
  confirmação. Os métodos não entram nos escopos dos tokens de agentes nem do controle remoto:
  só a IDE e a CLI leem e zeram.
- O `list_profiles` do Maestro passa a trazer, por perfil, o resumo dos últimos 30 dias (taxa
  de aprovação, duração média, custo médio por tarefa) quando há pelo menos 5 tarefas terminadas;
  abaixo disso, `"poucos dados"`. O prompt do Maestro diz que os números são um sinal, não uma
  regra.
- Nenhum dado sai da máquina e o placar não é sincronizado.

## Consequências

- Usuário e Maestro passam a ter números reais por perfil, com a ressalva escrita junto: são
  sinais indiretos (aprovação do diff, duração, custo, limites) e não medem a qualidade do código.
  Aprovação reflete o gosto de quem revisa, duração e custo dependem do tamanho da tarefa, e uma
  amostra pequena engana, por isso o mínimo de 5 tarefas.
- O Maestro pode passar a favorecer perfis com bom placar e deixar de testar os outros. O prompt
  limita isso (desempate, nunca contra uma falha verificada), mas o risco existe e vale observar.
- Um novo tópico de evento (`agent.review`) vira parte do protocolo; clientes que ignoram tópicos
  desconhecidos não são afetados.
- Execuções anteriores a esta versão não entram: o placar começa a contar quando o Core sobe com
  ele. Sessões antigas reabertas passam a contar como sessão no primeiro evento.
- A atribuição de uma execução a todos os perfis que participaram mistura maestro e subagentes;
  o placar não diz qual deles causou o resultado.
- Zerar apaga tudo de uma vez; não há zerar por perfil.

## Alternativas consideradas

- **Calcular sob demanda lendo `runs/`, `costs.jsonl` e as sessões:** diffs aceitos e limites
  não são guardados em lugar nenhum, e reler tudo a cada consulta é caro. Os contadores
  incrementais resolvem os dois.
- **Chamar o placar de dentro do `agents.ts` e do orquestrador:** acopla os módulos e espalha a
  lógica. Assinar o barramento deixa o placar removível sem mexer neles.
- **Uma nota única de qualidade por perfil:** daria uma falsa precisão. Os números ficam
  separados, cada um com o que realmente mede.
- **Telemetria na nuvem para comparar com outros usuários:** fora de questão; nenhum dado sai da
  máquina.
