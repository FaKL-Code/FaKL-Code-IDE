# 0052. Modo econômico de tokens

- Status: aceita
- Data: 2026-10-19
- Requisitos: RF-101, RF-201, RNF-13

## Contexto

O [ruflo](https://github.com/ruvnet/ruflo) (antes Claude Flow) se apresenta como um "meta-harness"
para o Claude Code e o Codex: 100 e poucos agentes, enxames com consenso, memória vetorial (HNSW),
federação entre máquinas, 300 e tantas ferramentas MCP e um console. A promessa que mais pesa para
quem paga por token é a economia, que o README e o `CLAUDE.md` dele atribuem a quatro coisas:
roteamento por camadas (um passo barato antes de chamar o modelo forte), recuperação de memória em vez
de recolocar contexto (citam -32%), aplicar edições sem gastar o modelo (-15%), cache (-10%) e
lotes (-20%), somando "30 a 50%".

Esses números são do projeto dele, sem metodologia publicada, e o próprio `CLAUDE.md` do ruflo marca
alguns como não verificados. Não vamos prometer o mesmo percentual. O que dá para fazer é aplicar os
mesmos mecanismos onde a FaKL-Code controla o fluxo, **medir** o que cada um economiza e mostrar o
número, com a ressalva de que ele é uma estimativa.

## O que é viável e o que não é

| Ideia do ruflo                                 | Aqui                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Roteamento por camadas (3 níveis)              | **Feito.** O Maestro escolhe o perfil pela camada de custo, usando o placar (ADR 0043).        |
| Respostas de ferramenta enxutas, cache         | **Feito.** Compactação e aviso de leitura repetida, no servidor MCP `fakl`.                    |
| Memória que evita recoletar contexto           | **Já existia**: vault com busca semântica (ADR 0029) e ferramentas `vault_*` para os agentes.  |
| Medir a economia (`token_usage`)               | **Feito.** Livro-caixa com a economia estimada, na barra de status e na API.                   |
| Agent Booster (aplicar edição sem modelo)      | Não. Depende de um motor próprio de merge; o agente já edita direto, sem reescrever o arquivo. |
| Enxames, consenso (Raft, bizantino), federação | Não. Não reduzem token (aumentam), e a FaKL-Code já tem Maestro, worktrees e relay.            |
| 100 agentes e 300 ferramentas                  | Não. Mais ferramentas ocupam mais contexto; o catálogo da FaKL-Code é pequeno de propósito.    |
| SONA, ReasoningBank (aprendizado)              | Não. Sem validação independente; o placar cobre o caso útil (quem acerta mais, por perfil).    |

A tradução honesta: o ruflo ganha tokens quando o modelo forte deixa de fazer o que um mais barato
faz, e quando o texto que volta ao modelo é menor. Os dois pontos cabem na FaKL-Code.

## Decisão

Um modo, `economia` no `config.yaml`, com três valores: `desligado`, `equilibrado` (padrão) e
`agressivo`. Vale para os agentes iniciados depois da troca (o servidor MCP lê o modo ao nascer).

1. **Compactação das respostas** (`packages/core/src/economia/compactar.ts`). Toda resposta de
   ferramenta MCP sai em JSON sem indentação (a indentação de 2 espaços era a maior parte do
   desperdício em listas), sem sequências ANSI, com linhas iguais e seguidas juntadas
   (`[linha acima repetida 40 vezes]`) e com texto longo cortado no meio, guardando o começo (60%) e o
   fim (40%) e dizendo quantos caracteres saíram. No `agressivo`, o limite de texto cai de 12 mil para
   5 mil caracteres e campos `null`, vazios e listas vazias saem. `desligado` devolve exatamente o
   que se devolvia antes.
2. **Leitura repetida** (`repeticao.ts`). A mesma ferramenta de leitura, com os mesmos argumentos,
   dentro de 45 s (90 s no `agressivo`), com resposta de 1.200 caracteres ou mais, responde um aviso
   curto com o começo do resultado, porque a primeira resposta ainda está na conversa. Qualquer chamada
   que não seja leitura (escrita, comando, SSH) esquece tudo, já que pode ter mudado o resultado.
   Só entram ferramentas de leitura de estado estável (vault, GitHub, recursos, perfis).
3. **Roteamento por camadas** (`roteador.ts`, `orchestrator.ts`). Heurística local, sem chamar modelo,
   classifica a tarefa em `baixa`, `media` ou `alta` por sinais do texto (arquitetura, segurança,
   migração, concorrência, refatoração ampla, investigação contra typo, formatação, documentação,
   renomear) e pelo papel (revisor sobe um ponto; sub-maestro nunca vai ao mais fraco). Cada nível tenta
   primeiro sua camada de `custoRelativo` e depois as vizinhas, entre os perfis instalados, não
   bloqueados pelo teto diário e permitidos na tarefa. Com amostra suficiente no placar, perfil com
   aprovação abaixo de 60% só recebe trabalho se não houver outro na camada; entre os demais, ganha a
   maior aprovação. A ferramenta nova `suggest_profile` mostra a escolha e o motivo; `spawn_agent`
   sem `profileId` (e sem perfil sugerido por agente ou skill) passa a usá-la, em vez de falhar. Quem
   passa `profileId` manda no resultado, sempre.
4. **Orientação nos prompts**. Com o modo ligado, o prompt do Maestro pede instruções precisas e
   relatos curtos, e o do executor pede para não colar arquivos nem logs inteiros e limitar o resumo
   final a 15 linhas.
5. **Livro-caixa** (`economia.ts`). O servidor MCP de cada agente soma o que compactou e o que deixou
   de repetir e avisa o Core em lote (a cada 5 s, se houve algo) por `economia.registrar`, único método
   novo liberado ao token do agente. O Core guarda só somas, por dia, em `~/.fakl/data/economia.json`
   (90 dias). Os tokens são **estimados** em 1 para cada 4 caracteres. O roteamento conta tarefas
   roteadas e as enviadas a um perfil mais barato que o de quem pediu; só mostra a diferença em dólar
   quando o placar tem dados dos dois perfis.
6. **Simplicidade de uso**. Nenhum passo de instalação ou `init`: o modo equilibrado vem ligado. A
   barra de status mostra "~N tokens economizados hoje"; o clique abre o resumo e a troca de modo
   (`FaKL: Trocar o modo de economia de tokens`). Pela API: `economia.status`, `economia.setModo`,
   `economia.reset`.

## Resultado medido

Medição sintética, em respostas parecidas com as reais (12 perfis, 30 issues, log de testes de 2.500
linhas com cor, 10 resultados de busca no vault), comparando com o JSON indentado de antes:

| Resposta                          | Equilibrado | Agressivo |
| --------------------------------- | ----------- | --------- |
| Lista de perfis                   | -31%        | -40%      |
| Lista de issues                   | -29%        | -41%      |
| Log de testes                     | -76%        | -90%      |
| Resultados do vault               | -14%        | -17%      |
| Total (17,3 mil tokens estimados) | -64%        | -77%      |

Isso vale para o **texto das respostas de ferramentas**, não para a sessão inteira: o prompt do
sistema, o que o modelo escreve e o que o agente lê por conta própria (arquivos, comandos do próprio
CLI) ficam de fora. O efeito na conta total depende do quanto o agente usa as ferramentas `fakl`; não
há medida de ponta a ponta com agentes reais ainda, e por isso a IDE mostra o que contou, não uma
promessa. O roteamento é onde mora o ganho maior (um perfil de custo baixo para uma tarefa simples),
e ele só aparece depois que há tarefas feitas e dados no placar.

## Consequências

- Resposta de ferramenta ficou menos legível para quem lê o log cru; o agente não perde informação,
  exceto no corte do meio de textos muito longos, que avisa e pede um trecho menor.
- A heurística de complexidade erra. Por isso `suggest_profile` mostra os sinais, o `profileId` explícito
  sempre vence e o placar tira de circulação quem vem sendo reprovado.
- O aviso de leitura repetida assume que o agente ainda tem a resposta anterior no contexto. Se o CLI
  do agente compactou a conversa nesse intervalo de 45 s, ele pode chamar de novo depois do prazo.
- O modo é lido quando o agente nasce; trocar de modo não muda agentes em andamento.
- Fora do escopo, de propósito: motor de aplicar edição sem modelo, enxames com consenso, federação,
  aprendizado por reforço. Se uma medida real mostrar que algum deles paga, entra em outra ADR.
