# 0027. Troca de conta do Claude com um clique, nos agentes abertos

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-101, RF-102
- Complementa: [0021](0021-contas-claude-em-paralelo.md), [0022](0022-agentes-persistentes.md)

## Contexto

Com o ADR 0021, trocar a conta ativa só valia para agentes novos. Quem bate o
limite de uso de uma assinatura quer passar tudo para outra de uma vez: os
agentes Claude abertos, os que vão nascer e os terminais, sem perder a
conversa. Mas o Claude Code guarda as conversas dentro da pasta de
configuração (`<CLAUDE_CONFIG_DIR>/projects`), que é diferente em cada slot:
aberta em outra conta, a sessão do agente não era achada.

## Decisão

- **Histórico compartilhado.** `~/.fakl/accounts/claude/<slot>/projects` é um
  link para `~/.fakl/accounts/claude/shared/projects` (junção no Windows, que
  não pede administrador; link de pasta nos outros sistemas). O Core faz isso
  ao iniciar e ao preparar um slot. Se o slot já tinha uma pasta `projects` de
  verdade (talvez com um Claude gravando nela), a migração nunca apaga nem copia
  conversa: a pasta é renomeada de uma vez para `projects.migrando-<epoch>` no
  próprio slot e o link nasce em seguida; se o rename falha (arquivo aberto no
  Windows), nada muda e a migração fica para o próximo início. Da pasta de
  migração, os arquivos vão para a comum só com rename; num arquivo que existe
  nos dois lados fica com o nome original o maior (as conversas só crescem) e,
  no empate, o mais novo, e o outro fica ao lado como `<nome>.slot<N>.jsonl.bak`
  (ou `.anterior.jsonl.bak`, quando quem perde é o da comum). O que não dá para
  mover fica na pasta de migração, reprocessada a cada início; só pastas vazias
  são removidas. Falhas vão para o log. O `~/.claude` do usuário continua
  intocado.
- **A sessão lembra a conta.** O registro da sessão em disco ganha
  `contaClaude` (opcional, sem migração). Ao retomar, vale a conta da sessão;
  sem ela, a ativa. Como no início, só perfis `anthropic` com adaptador `acp`.
- **Troca nos abertos.** `claude.accounts.setActive` aceita
  `aplicarEmAbertos` (padrão `true`) e chama `AgentRuntime.switchClaudeAccount`:
  - sessão ociosa: o agente antigo é encerrado sem avisar o barramento (nada de
    "parado", token revogado ou worktree guardado) e a mesma sessão (mesmo id,
    worktree, modo, opções e servidores MCP) reabre na conta nova pelo caminho da
    retomada: ACP `session/load` com o id guardado, que acha a conversa no
    histórico comum, e, se não der, o histórico do diário do Core. O chat continua
    com a conversa da memória e recebe `agent.state` com "conta trocada para
    <apelido>". Ao começar, a sessão publica `agent.state` `preparando` ("trocando
    para a conta <apelido>"); enquanto reabre, aparece assim e as mensagens
    esperam o agente novo. Parar (`stop`, `pause`, `settled`, `agents.stop`)
    durante a troca espera por ela: se o agente novo ainda não começou a subir,
    ele nem sobe; se está subindo, é parado assim que existir. Nos dois casos a
    sessão termina encerrada pelo caminho normal, com o worktree guardado no
    branch, e uma troca adiada não reabre uma sessão parada;
  - sessão no meio de uma vez: a troca fica pendente e acontece quando a vez
    acaba; nada é interrompido;
  - sessão encerrada ou guardada em disco: só muda a conta com que ela volta.
- **Evento `claude.account`** (assunto `claude`) com a conta ativa, a pasta, o
  `env` para terminais (`CLAUDE_CONFIG_DIR`, vazio na conta padrão) e as sessões
  afetadas. A IDE usa o `env` nos terminais novos. As ativações rodam uma de
  cada vez, na ordem pedida; a que foi superada por outra antes de começar não
  faz nada nem publica, e o RPC devolve o estado depois de todas terminarem.
- **Uso por conta com histórico comum.** A barra "Sessão de 5h e limite
  semanal" soma os tokens dos `.jsonl` do Claude Code; com `projects/`
  compartilhado, todas as contas mostrariam o mesmo total. O Core grava então
  `~/.fakl/accounts/claude/shared/contas.json` (atômico, sem segredos), com
  `ativas`, a conta ativa ao longo do tempo (`{ slot | null, desde }`, uma
  entrada a cada troca e a de partida no primeiro início), e `sessoes`, por id
  de sessão do Claude Code, a conta com que o Core rodou cada agente (gravada
  ao iniciar, reabrir e trocar, assim que o id ACP aparece). As conversas que
  já estavam num slot e foram migradas entram com `desde: 0` na conta de
  origem. A poda guarda, em cada linha do tempo (ativas e a de cada sessão), a
  última entrada antes do corte de 8 dias e as posteriores; uma sessão sai
  inteira só sem atividade há 8 dias, contada por `vistas` (atualizado pela
  atividade do agente, no máximo uma gravação por minuto por sessão). `claude.accounts.list` informa os caminhos (`compartilhada` e
  `atribuicao`). A extensão lê a pasta comum uma vez e reparte cada resposta:
  a entrada mais recente da sessão com `desde` até o instante dela, senão a
  conta ativa naquele instante; a conta padrão do CLI e o que fica sem
  atribuição não contam para nenhum slot. A conta padrão continua lendo
  `~/.claude/projects`, e um slot cujo `projects/` não é link lê a própria
  pasta, como antes.
- `ClaudeAccounts` não conhece o `AgentRuntime`: recebe `onSwitch` e `publish`
  nas opções, ligados no `createCore`.

## Consequências

- Todas as contas veem todas as conversas do Claude Code feitas pela IDE.
- Se a reabertura falhar (CLI sem login na conta nova, por exemplo), a sessão
  fica encerrada e retomável, com o trabalho do worktree guardado no branch.
- O uso por conta soma o gasto inteiro da sessão na conta atual dela; e o
  contador de tokens da sessão recomeça no agente novo, como numa retomada.
- Uma sessão pausada só troca quando voltar a ficar ociosa.
- A atribuição de terminais e do Claude Code fora da IDE segue a conta ativa
  no instante da resposta: um terminal aberto antes da troca, ainda com a conta
  antiga, conta na nova. Agentes do Core são atribuídos pela sessão e não têm
  esse erro.
