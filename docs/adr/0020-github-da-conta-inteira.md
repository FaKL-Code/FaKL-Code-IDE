# 0020. GitHub da conta inteira, não do repositório aberto

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-501, RF-502, RF-209, RF-210; SDD 11.1
- Complementa: [0010](0010-integracoes-com-cofre-em-memoria-e-aprovacoes-no-core.md)

## Contexto

A integração com o GitHub nasceu centrada no repositório aberto: os painéis
listavam PRs, issues e Actions só dos repositórios com `origin` no workspace, e
as ferramentas dos agentes exigiam um `repo` (ou a pasta do agente). Isso
repete o que o VSCodium já faz bem dentro de um repositório. O que falta a
quem trabalha em vários repositórios e organizações é a visão da conta: o que
foi atribuído a quem usa, o que espera sua revisão, como estão as Actions de tudo
o que a pessoa mantém e o que chegou nas notificações, sem abrir cada pasta.

## Decisão

- **A raiz é a conta.** O viewlet GitHub passa a ter as visões Conta (usuário,
  organizações e repositórios, com busca), Atribuídos a mim, Revisão pedida,
  Meus PRs, Issues, Actions (todos os repos) e Notificações agrupadas por
  repositório. O workspace vira um atalho ("Repos do workspace"), e
  `workspaceRepos()` deixa de ser a fonte principal. PRs, issues e execuções
  de repositórios fora do workspace abrem no navegador e mostram diff, jobs e
  log pela API; o checkout e "Mandar para agentes" oferecem clonar.
- **Busca em vez de varredura.** Atribuídos, revisões, PRs e issues usam
  `search/issues` com `@me` (`review-requested:@me`, `assignee:@me`,
  `author:@me`, `involves:@me`, `is:open`): uma chamada cobre todos os
  repositórios. Repositórios vêm de `/user/repos` (próprios, de colaboração e
  de organizações) e `/orgs/{org}/repos`.
- **Actions por fan-out limitado.** Não existe uma listagem de execuções da
  conta. O cliente pega os repositórios mais recentemente ativos (até 12 por
  padrão, sem arquivados), consulta `actions/runs` de cada um com concorrência
  4 e junta por data. Falhas por repositório (SSO, Actions desligado) viram um
  aviso na visão, não derrubam o resto.
- **Cliente cuidadoso com o limite.** `GitHubClient` segue a paginação pelo
  cabeçalho `Link` (só para URLs da própria API, para o token nunca sair dela),
  guarda ETag por URL (um 304 não gasta limite, inclusive nas buscas), controla
  separadamente o limite `core` e o de `search` (30 por minuto) e, com o
  limite esgotado, devolve o que já está em cache ou um erro com o horário de
  volta, sem insistir. A atualização automática da IDE roda a cada 90 s, só
  com o painel visível, a janela em foco e fora do limite.
- **Protocolo e Core.** `github.account.*` (`repos.list`, `orgs.list`,
  `prs.mine`, `prs.reviewRequested`, `prs.assigned`, `issues.mine`,
  `actions.recent`, `notifications.list`, `notifications.markRead`), tipados em
  `@fakl/protocol`. Leituras são livres; marcar notificações como lidas é
  escrita e, vindo de um agente, passa pela aprovação e pela auditoria já
  existentes. Os termos de busca de `repo` e `org` são validados antes de
  entrar na consulta.
- **Ferramentas MCP.** `github_my_prs`, `github_review_requests`,
  `github_my_issues`, `github_list_repos`, `github_recent_runs` e
  `github_notifications`, só de leitura. O parâmetro `repo` das ferramentas
  anteriores já aceitava `dono/nome` de qualquer repositório da conta, sem
  exigir o workspace, e continua assim. Os agentes seguem sem acesso ao token
  (`github.gitCredential` e `secrets.*` não entram em nenhum conjunto de
  ferramentas).
- **Erros que explicam.** O cliente reconhece SSO/SAML (cabeçalho
  `X-GitHub-SSO`, com a URL de autorização), token fine-grained sem acesso,
  escopo faltando, token expirado e limite de requisições, e devolve
  `GitHubError` com um `kind` e uma mensagem em português com o próximo passo.
  `FaKL: Diagnosticar acesso ao GitHub` confere conta, organizações,
  notificações e busca e diz o que ajustar (guia em
  [`docs/github.md`](../github.md)).
- **Painéis seguem falando direto com o GitHub**, como na 0010: a extensão usa
  o mesmo `GitHubClient` com o token do `SecretStorage`; o Core intermedeia só
  o que os agentes fazem.

## Consequências

- Quem usa várias organizações vê tudo num lugar, e os agentes respondem a
  "o que está esperando minha revisão?" sem saber em qual repositório olhar.
- A busca do GitHub tem limite próprio (30 por minuto) e indexa com atraso de
  alguns segundos; a visão pode demorar a mostrar um PR recém-criado.
- A visão de Actions é aproximada: cobre os repositórios mais ativos, não
  todos. Para um repositório fora da lista, use o filtro "Só alguns
  repositórios" ou `github_list_runs` com `repo`.
- Notificações não funcionam com token fine-grained (limitação da API do
  GitHub); a conta do GitHub da IDE e o token clássico funcionam.
- Organizações com SSO exigem que o token seja autorizado nelas; sem isso os
  repositórios da organização falham, com a mensagem e o link para autorizar.
- Os nomes dos painéis mudaram (`fakl.github.prs` e `fakl.github.releases`
  saíram; as releases ficam dentro de cada repositório). Quem tinha um layout
  personalizado do viewlet verá as visões novas nas posições padrão.

## Alternativas consideradas

- **GraphQL numa consulta só:** reduziria chamadas, mas exige escopos e
  paginação próprios e não traz as execuções do Actions. A busca REST com ETag
  cobre o caso com o cliente que já existe.
- **Listar execuções de todos os repositórios:** custa uma chamada por
  repositório; o fan-out limitado entrega o útil (o que mudou há pouco) com
  custo previsível.
- **Mover os painéis para o Core:** o token teria de sair do `SecretStorage`
  para o Core a cada atualização de tela, e o Core já recebe o que precisa
  para os agentes. Manter os painéis diretos evita um salto sem ganho.
- **Webhooks ou eventos de organização:** exigem endpoint público e um GitHub
  App; fora de escopo para uma IDE local. O polling leve com ETag basta.
