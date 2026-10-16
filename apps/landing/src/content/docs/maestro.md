---
titulo: Maestro e tarefas
descricao: Tarefas, critérios de pronto, limites, teto diário, decisões e entrega.
ordem: 4
---

## Uma tarefa

Crie uma tarefa com **Nova tarefa para o maestro** ou, a partir de um texto solto, com **Pôr o maestro para trabalhar**. Uma tarefa tem:

- o pedido e o repositório;
- o perfil do Maestro;
- os **critérios de pronto**, como comandos que precisam passar (`pnpm test; pnpm lint`);
- a forma de entrega: merge, PR, PR com merge ou só o branch;
- o modo de permissão.

O Maestro planeja, cria subagentes escolhidos pelos perfis, espera os resultados, revisa os diffs e junta o trabalho. Cada volta desse ciclo é uma **rodada**. A execução termina quando os critérios de pronto passam.

## Limites

Rodadas, tempo, tokens e custo têm limite. O valor vale para tudo (`~/.fakl/config.yaml`), por playbook ou por tarefa, e o mais específico ganha. Quando um limite estoura, acontece o que você configurou:

| Ação                 | O que faz                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `perguntar` (padrão) | Pausa a execução e cria uma decisão: aumentar o limite, entregar rascunho, escalar ou descartar |
| `rascunho`           | Entrega o que já existe como PR rascunho                                                        |
| `escalar`            | Troca o Maestro por um perfil mais forte, com um orçamento extra                                |
| `descartar`          | Encerra e descarta o trabalho                                                                   |

Além disso, há um **teto diário de gasto** por provedor, ajustado com **Ajustar teto diário de gasto**. O gasto aparece ao vivo na Mesa e no comando **Gasto com agentes hoje**.

## Decisões pendentes

Quando a execução precisa de você, nasce uma decisão: um limite que estourou, um possível segredo no diff, uma pergunta do Maestro. Elas aparecem em **Decisões pendentes**, na Mesa, no celular e em `fakl decisoes`.

## Orquestrar pelo chat

Uma conversa comum no chat também pode chamar subagentes. A conversa vira o Maestro de uma execução sem prazo nem orçamento, e a Mesa desenha os fios do mesmo jeito.
