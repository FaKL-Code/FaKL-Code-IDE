# GitHub na FaKL-Code: conta inteira

A barra lateral GitHub mostra a sua conta, não só o repositório aberto
([ADR 0020](adr/0020-github-da-conta-inteira.md)). Este guia cobre o que cada
visão mostra, como os agentes usam e o que fazer quando o GitHub recusa um
pedido (SSO, token fine-grained, limite).

## Visões

| Visão                    | O que mostra                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Conta                    | Você, suas organizações e colaborações, com os repositórios; botão de busca por nome       |
| Atribuídos a mim         | PRs e issues abertos atribuídos a você, em todos os repositórios                           |
| Revisão pedida           | PRs que esperam sua revisão                                                                |
| Meus PRs                 | PRs abertos criados por você                                                               |
| Issues                   | Issues que envolvem, foram atribuídas ou foram criadas por você (filtro no botão da visão) |
| Actions (todos os repos) | Execuções recentes dos repositórios mais ativos, com filtro de status e de repositórios    |
| Notificações             | Agrupadas por repositório; "marcar como lida" por item, por repositório ou todas           |
| Repos do workspace       | Atalho para os repositórios das pastas abertas (aparece só se houver `origin` no GitHub)   |

Cada repositório da visão Conta abre em Pull requests, Issues, Actions e
Releases. Um item de um repositório que não está no workspace funciona igual:

- **Abrir:** o link abre no navegador.
- **PR:** os arquivos e o diff vêm pela API; revisar, comentar e fazer merge
  também. **Checkout** e **Mandar para agentes** pedem uma cópia local: se o
  repositório não está aberto, a IDE oferece clonar.
- **Actions:** jobs e log pela API, e "rodar de novo".

A atualização é automática a cada 90 s, só com o painel visível e a janela em
foco; o ETag evita gastar o limite de requisições quando nada mudou.

## GitHub em tela cheia

O botão **Abrir o GitHub em tela cheia** (ícone de tela cheia no topo de
qualquer visão do GitHub, ou `FaKL: Abrir o GitHub em tela cheia` na paleta)
abre um painel no editor que funciona como um GitHub dentro da IDE. No menu de
contexto de um repositório, dono, PR, issue, execução ou notificação, a mesma
ação abre o painel direto naquele item. Não é um iframe nem o navegador
embutido: as telas são da IDE, com os dados lidos pela API
([ADR 0030](adr/0030-github-em-tela-cheia-renderizado-pela-api.md)).

| Tela           | O que mostra                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Início         | Sua conta, PRs com revisão pedida, seus PRs, issues atribuídas, notificações não lidas e repositórios recentes                                                     |
| Repositório    | Cabeçalho (visibilidade, estrelas, forks) e as abas Código, Issues, Pull requests, Actions e Releases                                                              |
| Código         | Arquivos por pasta, troca de branch, último commit e README renderizado; ao lado, sobre, tópicos, linguagens, releases e contribuidores                            |
| Arquivo        | Markdown renderizado ou código com números de linha; **Abrir no editor** usa a cópia do workspace ou abre a versão do GitHub só de leitura                         |
| Pull request   | Descrição, conversa com revisões, arquivos alterados (clique abre o diff no editor) e checks; revisar, merge, checkout e comentar                                  |
| Issue          | Corpo, rótulos e comentários; comentar e **Mandar para agentes**                                                                                                   |
| Execução       | Jobs com estado e duração; **Ver log** e **Rodar de novo**                                                                                                         |
| Notificações   | Agrupadas por repositório; marcar como lida, uma a uma ou todas                                                                                                    |
| Usuário ou org | Coluna com avatar, nome, bio, seguidores, empresa, local, blog e organizações (ou pessoas, numa org); abas Visão geral, Repositórios e Estrelas (Pessoas numa org) |

Perfil:

- **Visão geral**: o README do perfil (`login/login`, ou `.github/profile` numa
  organização) e os repositórios fixados, lidos pelo GraphQL; sem fixados,
  os mais populares por estrelas.
- **Repositórios**: **Encontrar um repositório…** (nome e descrição), **Tipo**
  (Todos, Públicos, Privados, Fontes, Forks, Arquivados), **Linguagem** e
  **Ordenar** (Última atualização, Nome, Estrelas). Na sua conta a lista vem de
  `/user/repos` e inclui os privados; nos outros, de `/users/{login}/repos` ou
  `/orgs/{org}/repos`. O painel lê até 500 repositórios do dono e filtra ali
  mesmo; a lista fica guardada por 2 minutos (ou até **Atualizar**), então
  trocar filtro não gasta a API. Acima de 500, um aviso leva à lista completa
  no GitHub.
- **Estrelas**, **Seguidores** e **Seguindo** (pelos contadores da coluna) e
  **Pessoas** de uma organização vêm de página em página.
- A aba e os filtros fazem parte do endereço: voltar e avançar funcionam, e
  links como `github.com/octo?tab=repositories&type=source&sort=stargazers` ou
  `github.com/orgs/acme/repositories` abrem a mesma tela. A busca digitada
  troca a entrada do histórico em vez de empilhar uma por letra.
- No topo, o avatar da sua conta abre o seu perfil e o ícone de repositório
  (**Seus repositórios**) abre a aba Repositórios; no início, **Ver todos** dos
  repositórios recentes leva à mesma aba.

Navegação:

- **Voltar e avançar** pelos botões, `Alt+←`/`Alt+→` ou os botões laterais do
  mouse; o caminho no topo é clicável.
- **Busca** (`/` foca o campo): procura repositórios no GitHub inteiro. Colar
  um link do github.com abre aquela tela no painel.
- Links do Markdown para arquivos do repositório, issues, PRs e perfis abrem no
  painel, inclusive a âncora (`./guia.md#setup` rola até a seção); os demais
  abrem no navegador do sistema. O ícone de link no topo abre a tela atual no
  navegador.
- Links com branch que tem `/` (`/blob/feature/auth/...`) abrem no branch
  certo: o painel confere a lista de branches e tags do repositório.
- Issues, PRs, Actions, releases, busca e repositórios de um perfil vêm de
  página em página: **Carregar mais** traz a próxima, e **Ver tudo no GitHub**
  abre a lista completa. As listas do início mostram o total e o mesmo link.
- Um repositório sem commits mostra **Repositório vazio**, com os comandos para
  clonar e fazer o primeiro push.
- Comentar: o compositor avisa se o texto passar de 65.536 caracteres (o limite
  do GitHub) e, se o envio falhar, mostra o erro ali mesmo e mantém o texto.
- **Rodar de novo** uma execução pede confirmação.

Limites: o Markdown segue o do GitHub (tabelas, listas de tarefa, avisos
`> [!NOTE]`, HTML comum), mas sem emoji por `:código:` e com realce de sintaxe
leve. HTML perigoso (scripts, eventos, `javascript:`) é removido. Imagens com
caminho relativo em repositórios privados não carregam, porque o token não vai
para a tela; abra o arquivo no GitHub.

## Ferramentas dos agentes

Todas de leitura, sem depender do repositório da pasta do agente:

| Ferramenta               | Retorna                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `github_my_prs`          | PRs criados por você em todos os repositórios                        |
| `github_review_requests` | PRs que pedem sua revisão                                            |
| `github_my_issues`       | Issues atribuídas (padrão), criadas ou que envolvem você             |
| `github_list_repos`      | Repositórios da conta, com filtro por busca e organização            |
| `github_recent_runs`     | Execuções do Actions nos repositórios mais ativos (filtro de status) |
| `github_notifications`   | Notificações, não lidas por padrão                                   |

As ferramentas por repositório (`github_list_prs`, `github_get_issue`,
`github_run_logs` e as demais) aceitam `repo` como `dono/nome` de qualquer
repositório da conta. Comentar, abrir PR fora de `fakl/*` e marcar
notificações como lidas pedem a sua aprovação. O token nunca chega ao agente.

## Escopos e tipos de token

| Origem do login                      | Serve para tudo?                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Conta do GitHub da IDE (menu Contas) | Sim: pede `repo`, `workflow`, `notifications` e `read:org`                      |
| `gh auth token` ou device flow       | Sim, com os mesmos escopos                                                      |
| Token clássico colado                | Sim, com `repo`, `workflow`, `notifications` e `read:org`                       |
| Token fine-grained colado            | Parcial: não acessa notificações, e só enxerga o que for liberado (veja abaixo) |

### Token fine-grained

- Em **Repository access**, escolha **All repositories** (ou inclua os que
  quer ver). Num token que cubra só alguns repositórios, a busca da conta
  mostra apenas esses.
- Permissões de repositório, só leitura: **Metadata**, **Pull requests**,
  **Issues** e **Actions**. Para comentar, revisar, fazer merge ou rodar de
  novo, use leitura e escrita nas permissões correspondentes.
- Para listar organizações, o token precisa ser criado com a organização como
  **Resource owner**, e a organização precisa aprovar tokens fine-grained.
- A API de **notificações não aceita** tokens fine-grained. Use a conta do
  GitHub da IDE ou um token clássico.

A mensagem "o token não tem acesso a este recurso" indica um token fine-grained
sem a permissão ou o repositório pedido.

### Organizações com SSO

Se a organização exige SAML SSO, um token (clássico ou o da conta da IDE) só
vale nela depois de autorizado:

1. Abra `https://github.com/settings/tokens` (ou **Aplicativos autorizados**,
   para o login pela conta da IDE).
2. Ao lado do token, escolha **Configure SSO** e **Authorize** a organização.
3. Volte à IDE e atualize o painel.

A visão mostra "Organização com SSO: autorizar o token" com o link direto que o
GitHub informou. As Actions de repositórios assim aparecem como "N
repositórios não puderam ser lidos" no fim da lista.

## Diagnóstico

`FaKL: Diagnosticar acesso ao GitHub` (também no menu da barra lateral) confere
a conta, as organizações visíveis ao token, a leitura dos repositórios de cada
uma, as notificações e a busca, e escreve o resultado no canal de saída
"FaKL GitHub". O token nunca é impresso.

## Limites da API

- Leituras comuns: 5.000 por hora; a busca (`search`) tem limite próprio de 30
  por minuto. As respostas 304 do ETag não contam.
- Ao esgotar, a IDE para de insistir, mostra o que já tinha em cache e avisa
  quando o limite volta.
- A busca demora alguns segundos para indexar itens novos.
