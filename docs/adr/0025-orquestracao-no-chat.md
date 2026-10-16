# 0025. Orquestração no chat: todo agente chama outros agentes

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-203, RF-106

## Contexto

As ferramentas `spawn_agent`, `await_results`, `merge_work` e as outras do
maestro só chegavam ao agente que o orquestrador iniciava numa tarefa
(`runs.start`). Quem abria um agente pelo chat ou pela Mesa recebia o servidor
MCP `fakl` só com vault e integrações. Mesmo que recebesse as ferramentas, o
Core recusaria a chamada: `caller()` exigia uma sessão registrada como maestro
de uma execução.

No Maestri, qualquer agente na mesa chama outros (Maestro Mode). Aqui, pedir
"delegue isso ao Codex" no chat não fazia nada.

## Decisão

- Toda sessão iniciada pela IDE (`agents.start`) recebe o conjunto
  `orquestrar`. Ele tem as ferramentas do maestro, menos `finish`, porque a
  conversa não é uma tarefa com entrega.
- O prompt dessas sessões explica as ferramentas e quando usá-las.
- Na primeira chamada, o Core cria uma **execução implícita**:
  - a tarefa tem `origem: 'chat'` e o título "Chat com <perfil>";
  - a sessão do chat é o maestro, com profundidade 0;
  - o branch é o do worktree da conversa.

  A partir daí, `spawn_agent`, `await_results`, `review_diff` e `merge_work`
  funcionam como numa tarefa. A Mesa desenha os cabos a partir de
  `Run.agentes`, como sempre.

- A execução implícita não tem prazo, orçamento nem rodadas; só vale a
  profundidade máxima. Também não tem lembretes de `finish`, nem decisão no
  teto diário, nem entrega.
- Quando a conversa termina, os subagentes param e a execução fica
  `concluída`, com o trabalho nos branches. Se a IDE fecha, ela não é
  retomada. Uma conversa retomada depois, com o mesmo id, abre uma execução
  implícita nova ao delegar de novo.
- Um subagente comum recebe só as integrações. As ferramentas de orquestração
  ficam com quem é maestro.
- Uma conversa sem worktree, que trabalha direto na pasta, também delega:
  - os subagentes partem do branch atual;
  - `merge_work` explica como integrar com `git merge`.

  Uma pasta sem git recebe um erro que diz o que fazer.

## Consequências

- "Chama o Codex para revisar" funciona no chat, com cabos na Mesa e o diff do
  subagente integrado no branch da conversa. Como todo trabalho de agente (ADR
  0016), ele não chega sozinho à pasta do usuário: a conversa entrega o branch
  por push e PR.
- As tarefas de origem `chat` aparecem em `tasks.list`. As visões de tarefas
  podem escondê-las ou agrupá-las depois.
