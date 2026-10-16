# 0021. Até três contas do Claude logadas ao mesmo tempo

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-101, RF-102; SDD 8.2, 8.4, 14.1
- Complementa: [0010](0010-integracoes-com-cofre-em-memoria-e-aprovacoes-no-core.md)

## Contexto

O Claude Code guarda o login numa única pasta de configuração (`~/.claude`).
Quem tem mais de uma assinatura (pessoal, trabalho, uma segunda para o limite
de uso) precisa sair e entrar de novo para trocar, e todos os agentes Claude da
IDE passam a usar a mesma conta.

## Decisão

- **Três slots, cada um com a sua pasta.** O Core cria
  `~/.fakl/accounts/claude/<1..3>` e roda o Claude Code de cada agente com
  `CLAUDE_CONFIG_DIR` apontando para o slot escolhido. Os logins não se
  misturam e nada do `~/.claude` do usuário é tocado. O ambiente do agente
  continua filtrado pela lista de permissão (`agentEnv`); o caminho do slot
  entra como variável extra da sessão, a única adição.
- **Login pelo próprio CLI, num terminal da IDE.** A ação "Entrar" abre um
  terminal com `CLAUDE_CONFIG_DIR` do slot e roda `claude auth login`. "Sair"
  chama `claude auth logout` no mesmo ambiente.
- **O Core não lê credenciais.** O estado vem de `claude auth status` (JSON)
  rodado com o ambiente do slot, e só `loggedIn`, `email` e `subscriptionType`
  são aproveitados; o resto da saída é descartado e nada dela vai para log ou
  evento. Se a CLI não está instalada, o estado fica desconhecido.
- **Conta ativa e apelidos** ficam em `~/.fakl/data/claude-accounts.json`
  (local da máquina, sem segredos). Sem conta ativa, os agentes Claude usam a
  conta padrão do CLI, como antes. A conta vale só para perfis `anthropic` com
  adaptador `acp`.
- **Escolha por agente.** `agents.start` aceita `contaClaude` (1 a 3); sem ele,
  vale a ativa. Com `fakl.claude.perguntarConta` ligado, a IDE pergunta a conta
  ao criar um agente Claude quando há duas ou mais logadas. A sessão
  (`agents.list`) informa `contaClaude` (slot e apelido), mostrado de forma
  discreta no chat e na Mesa.
- **Uso por conta.** O gasto de hoje de cada slot soma o das sessões que o
  usaram, a partir da contabilidade de custos existente.
- **API.** Domínio novo `claude`: `accounts.list`, `accounts.prepare`,
  `accounts.rename`, `accounts.setActive` (`slot: null` volta à conta padrão) e
  `accounts.logout`. Na CLI: `fakl contas`, `fakl conta usar` e
  `fakl conta renomear`. Na IDE, a área "Contas Claude" na barra de atividades,
  acima do GitHub.

## Consequências

- Agentes já em execução não trocam de conta; vale para os novos. (Mudou com o
  [ADR 0027](0027-troca-de-conta-claude.md): a troca vale também para os
  abertos, com o histórico do Claude Code compartilhado entre as contas.)
- O limite de três é fixo na interface; aumentar é mudar `CLAUDE_ACCOUNT_SLOTS`.
- Trocar de conta no meio de uma tarefa do orquestrador usa a conta ativa no
  momento em que cada agente nasce.
