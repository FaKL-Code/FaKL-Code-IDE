# Placar dos agentes

O placar mostra, por perfil de agente, números reais do que aconteceu na sua máquina: quantas
tarefas terminaram, quanto tempo levaram, quanto custaram e quanto do que o agente propôs você
aceitou. Serve para você, e para o Maestro, decidirem com dados qual perfil usar, em vez de
intuição. A decisão e as alternativas estão na [ADR 0043](adr/0043-placar-de-agentes.md).

Nenhum dado sai da máquina. Os contadores ficam em `~/.fakl/data/scorecard.json`, que não
sincroniza com outras máquinas nem com o vault.

## O que é medido

Por perfil e por período (últimos 7 dias, últimos 30 dias e o total guardado):

| Medida                        | Como é contada                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Sessões                       | Sessões de agente com atividade, uma vez cada (reabrir a sessão não conta de novo)              |
| Tarefas concluídas            | Execuções que terminaram bem e em que o perfil participou (como maestro ou subagente)           |
| Tarefas com falha             | Execuções que terminaram em falha                                                               |
| Tarefas canceladas            | Execuções descartadas: você cancelou a tarefa ou um limite mandou descartar                     |
| Duração média e mediana       | Do início ao fim da execução, sem o tempo esperando a cota do provedor renovar                  |
| Tokens e custo                | O que o Core já registra em [custos](sdd.md): a diferença do acumulado de cada sessão do perfil |
| Custo médio por tarefa        | Custo das sessões que pertencem a tarefas, dividido pelas tarefas terminadas                    |
| Arquivos aceitos x rejeitados | Arquivos do diff que você aplicou ou rejeitou (pelo chat, pela Mesa ou pela API)                |
| Taxa de aprovação             | aceitos / (aceitos + rejeitados); sem nenhum arquivo decidido, não há taxa                      |
| Limites de uso atingidos      | Vezes que o perfil ficou esperando a janela do plano ou parou no teto diário do provedor        |

Detalhes que mudam a leitura dos números:

- Uma execução com vários perfis (um maestro e dois subagentes, por exemplo) conta uma vez para
  cada perfil que participou. O resultado da tarefa é do conjunto, não de um perfil só.
- O período vale pelo dia (fuso local) em que o evento aconteceu, não pelo dia em que a tarefa
  foi criada.
- O limite de uma execução (rodadas, tempo, tokens definidos na tarefa) não conta como limite de
  uso: ele mede a tarefa, não o provedor.
- O trabalho que o Maestro integra com `merge_work` não passa pelo diff da IDE, então não entra
  na aprovação: a taxa vem só das sessões em que você mesmo revisa o diff.

## O que NÃO é medido

O placar **não mede a qualidade do código**. Ele junta sinais indiretos:

- Aprovação do diff reflete o seu gosto, o tamanho do que foi pedido e se você revisou de verdade.
  Aceitar tudo sem ler também dá 100%.
- Uma tarefa concluída é uma tarefa em que o critério de pronto passou, não uma tarefa bem feita.
- Duração e custo dependem do tamanho da tarefa. Um perfil que recebe só tarefas difíceis parece
  pior do que um que recebe só tarefas fáceis.
- Perfis com poucas tarefas são ruído. Abaixo de 5 tarefas no período, a IDE e o Maestro mostram
  "poucos dados" em vez de números.

Use o placar para desempatar perfis parecidos e para notar tendências (um perfil que passou a
bater limite toda semana, um que você sempre rejeita). Não use para provar que um modelo é melhor
que outro.

## Onde ver

- **IDE:** a view **Placar dos agentes**, no painel de recursos de IA, com uma linha por perfil
  (tarefas, aprovação, duração e custo médios) e o detalhe no tooltip. O botão de calendário troca
  o período; o de limpar zera, pedindo confirmação.
- **CLI:** `fakl placar` mostra a tabela dos últimos 30 dias. `fakl placar 7d` e `fakl placar total`
  trocam o período, e `--json` imprime a resposta crua.
- **API local:** `scorecard.get` (com `periodo`: `7d`, `30d` ou `total`) e `scorecard.reset`.
- **Maestro:** a ferramenta `list_profiles` traz, para cada perfil, o campo `placar` com os
  últimos 30 dias: taxa de aprovação, duração média em minutos e custo médio por tarefa, ou
  `"poucos dados"` quando o perfil tem menos de 5 tarefas terminadas. O prompt do Maestro diz que
  esses números são um sinal, não uma regra.

## Como zerar

Qualquer um destes apaga todos os contadores, de todos os perfis e períodos, sem volta:

- na IDE, o botão **Zerar o placar dos agentes** da view (pede confirmação);
- `fakl placar zerar --confirmar`;
- apagar `~/.fakl/data/scorecard.json` com a IDE fechada.

Sessões que estavam abertas na hora de zerar voltam a contar como sessão nova no próximo evento.

## Retenção e arquivo

- O histórico por dia fica 90 dias; o total acumulado não expira. Os períodos de 7 e 30 dias saem
  do histórico por dia.
- Para a mediana, ficam as 200 durações mais recentes de cada perfil por dia e as 500 mais recentes
  no total; a média usa a soma completa.
- A gravação é atômica (arquivo temporário e renomeação) e acontece pouco depois de cada mudança.
- Um arquivo corrompido não derruba o Core: ele é renomeado para `scorecard.json.corrompido` e o
  placar recomeça vazio. Campos inválidos dentro de um arquivo legível são descartados.
- Perfis apagados continuam no histórico, marcados como removidos, até zerar ou sair da retenção.
