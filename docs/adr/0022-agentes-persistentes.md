# 0022. Agentes que sobrevivem a reinícios e atualizações

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-106, RNF-13; SDD 6.2 (`store`, `runtime`), 8.2; ADR 0007

## Contexto

As sessões de agente viviam só na memória do Core. Ao reiniciar o Core ou
atualizar a IDE (o instalador troca o app, mas `~/.fakl/data` fica), a lista, a
Mesa e o chat perdiam os agentes e as conversas.

## Decisão

- O `runtime` grava cada sessão avulsa em `~/.fakl/data/agents/`:
  - `<sessão>.json` (gravação atômica): perfil, pasta ou worktree (com branch e
    commit base), modo de permissão, opções escolhidas (modelo, raciocínio,
    rápido), título (primeira mensagem), estado, motivo do encerramento, id da
    sessão no agente (ACP), regras do prompt de sistema e uso. Nunca tokens do
    servidor MCP, variáveis de ambiente ou arquivos; o prompt passa pelo `redact`;
  - `<sessão>.jsonl` (só inserção): a conversa, como os eventos `agent.*` que o
    chat monta, mais as mensagens do usuário. Pedaços de texto seguidos viram um
    item só.
- Sessões de uma tarefa (`taskId`) ficam com o orquestrador, que já guarda
  tarefas e execuções; só as avulsas entram aqui.
- Ao iniciar, o Core lê tudo (`agents.load`). Sessões que estavam trabalhando
  quando o Core caiu viram `parado` com motivo `interrompida`, e o trabalho solto
  do worktree vai para o branch. Elas aparecem na lista, na Mesa e no chat com
  `retomavel: true` e a conversa intacta (`agents.transcript`).
- Uma mensagem nova (ou `agents.resume`) numa sessão encerrada a retoma, com a
  mesma id: o worktree é reaberto a partir do branch e o adaptador ACP tenta
  `session/load` (ou `session/resume`) com o id guardado; se o agente não
  suporta ou recusa, recria a sessão e entrega o histórico em texto como
  contexto. O modelo e as demais opções escolhidas são reaplicados.
- Ao fechar, `stopAll` grava o estado final de cada sessão antes de sair.
- Formato com versão (`versao`). Cada mudança de formato soma um passo de
  migração; registro de versão mais nova que a do Core (downgrade) é ignorado e
  deixado intacto no disco.
- Limites: 3000 itens e 1 MB de texto por conversa (os mais antigos saem, na
  leitura e por compactação); sessões encerradas há mais de 30 dias ou além das
  100 mais recentes são apagadas ao iniciar. `agents.forget` e "Limpar
  encerrados" apagam na hora.

## Consequências

- O custo acumulado exibido de uma sessão retomada recomeça do zero (o agente
  novo informa só o que gastou depois); o livro de custos do dia não muda.
- Sessões de tarefas não voltam como conversa; o que o orquestrador retoma
  continua sendo decidido por ele.
- Novos métodos do Core: `agents.transcript` e `agents.forget`.
