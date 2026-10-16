# FaKL-Code: Core

Extensão embutida da FaKL-Code IDE.

- Traz o processo do FaKL Core (`dist/core.mjs`). O processo principal da IDE o
  inicia ao abrir e o encerra ao fechar (ADR 0005); não há serviço rodando com
  a IDE fechada.
- Mostra o estado do Core na barra de status. O comando `FaKL: Estado do FaKL
Core` dá os detalhes: versão, pid e endereço da API local.

- `FaKL: Agentes disponíveis` mostra quais agentes (Claude Code, Codex, Gemini
  CLI) estão instalados e instala os que faltam num terminal.
- **Chat dos agentes** (barra lateral secundária, "Agentes FaKL"): o mesmo
  jeito do chat do VS Code. Numa conversa nova, escolha o agente e onde ele
  trabalha (worktree próprio, no branch `fakl/avulso/<sessão>` e com o
  trabalho commitado ao parar, ou a pasta aberta) e mande a mensagem. A
  resposta chega aos poucos, com as ferramentas usadas e os pedidos de
  permissão, que se respondem ali mesmo. Dá para pausar, retomar e encerrar,
  e trocar de conversa pela lista no topo. `FaKL: Abrir chat dos agentes`
  abre o chat.
- **Alterações do agente** (RF-107): com o agente num worktree, o chat lista
  os arquivos que ele mudou, com linhas acrescentadas e removidas. Clicar
  abre o diff (início ↔ agente); ✓ aplica o arquivo na sua pasta, mesclando
  com o que você mudou nele (conflitos ficam marcados), e ✕ descarta a mudança
  no worktree do agente.
- **Mesa de controle** (ícone FaKL-Code na barra lateral): a árvore de agentes
  mostra cada sessão ao vivo, com estado, custo e pasta ou branch. O título
  da view soma os ativos e o custo. Clicar num agente abre a conversa dele no
  chat; os botões pausam, retomam e param, e o menu abre o log, que é um
  painel de saída por sessão, e um terminal na pasta ou worktree do agente. Pedidos de permissão de conversas que não estão
  abertas no chat viram notificações.
- **Perfis** (RF-101, na mesma barra): cada perfil é um arquivo em
  `~/.fakl/profiles/<id>.yaml` com nome, provedor, modelo, pontos fortes,
  custo relativo, regras e se pode ser maestro. `+` cria um perfil e abre o
  arquivo; clicar edita; a lixeira apaga. O Core relê ao salvar, e o chat
  passa a oferecer o perfil novo. O modelo vai para cada CLI do jeito dela
  (`ANTHROPIC_MODEL`, `-c model=` no Codex, `--model` no Gemini) e as regras
  abrem a primeira mensagem.
- **Recursos de IA** (ícone Recursos de IA): reúne perfis, agentes, skills e
  servidores MCP. Agentes e skills são instalados na IDE em
  `~/.fakl/resources`; o catálogo embutido é instalado na primeira abertura e
  novos itens do catálogo podem ser escolhidos pelo título das views. Também é
  possível criar, abrir, editar e remover recursos próprios ali, sem deixar
  arquivos soltos no repositório. Os servidores MCP continuam específicos do
  workspace em `.vscode/mcp.json`; adicionar e remover um servidor preserva as
  demais chaves da configuração.
- **Modelos locais** (RF-104): no `+` dos perfis, "Modelo local no Ollama" ou
  "no LM Studio" cria um perfil com `adaptador: ollama`. Troque o `modelo`
  pelo nome que o servidor lista (`ollama list`) e, se ele estiver em outra
  máquina, informe `endpoint`. O modelo lê, busca, edita e roda comandos no
  worktree, com as mesmas permissões dos outros agentes, e custa zero no
  gasto do dia.
- **Tarefas** (SDD 9, na barra FaKL-Code): `+` cria uma tarefa com título,
  objetivo, maestro, critério de pronto (comandos) e entrega (padrão: PR
  mesclado na main, com o workflow de `buildAposMerge` disparado se houver; ou só PR, merge local ou
  branch). O maestro recebe o servidor MCP `fakl`: cria subagentes em
  worktrees, espera resultados, integra, roda o critério por rodada e chama
  `finish`. Limites de rodadas, tempo, tokens e custo vêm da tarefa ou do
  `config.yaml`; ao estourar, a IDE pergunta o que fazer (aumentar, rascunho,
  escalar, descartar). Decisões pedidas pelo maestro aparecem como aviso e em
  "Decisões pendentes".
- **Comandos por voz** (ADR 0031): `FaKL: Falar um pedido` (Ctrl+Alt+V,
  Cmd+Alt+V no Mac, e o microfone no título do chat, da mesa e na Mesa) abre
  "O que você quer?", que já começa a gravar. Enter ou o botão param e
  transcrevem; a transcrição fica editável e o cartão mostra o que o pedido
  vira: tarefa para o maestro (com o repositório, o maestro e o critério que
  você disse), conversa nova com um agente ou mensagem para a conversa aberta
  no chat. Com pouca certeza, o seletor pede a escolha. Ctrl+Enter envia, Esc
  fecha. O microfone também fica no compositor do chat e de cada cartão da
  Mesa (Ctrl+Shift+Espaço liga e desliga): o texto ditado entra no campo e
  você envia como sempre. A voz começa desligada: `FaKL: Configurar voz`
  escolhe o modo — reconhecimento do navegador (grátis e sem chave, só no
  app do celular), OpenAI, Groq ou um servidor local compatível com whisper
  (endereço e modelo à sua escolha) — e também desliga. Na IDE quem
  transcreve é sempre o Core; a chave fica no cofre do sistema e vai ao Core
  como `voz.token`, e o modo, o modelo, o endpoint e o idioma ficam em `voz:`
  no `~/.fakl/config.yaml`. Sem acesso ao microfone (ou no modo navegador),
  o ditado do Windows (Win+H) funciona em qualquer campo.
- **Gasto** (RNF-13): `FaKL: Gasto com agentes hoje` (também no título da
  mesa) mostra tokens e custo do dia por provedor. Com `tetoDiario` no
  `config.yaml`, ao bater o teto os agentes daquele provedor pausam, novas
  mensagens são recusadas até o dia virar e um aviso oferece ajustar o teto.
  Os lançamentos ficam em `~/.fakl/data/costs.jsonl`.
- **Cyber café** (SDD 13): `FaKL: Abrir o cyber café` (também no título da
  mesa) abre uma sala em pixel art com um avatar por agente, na cor do
  provedor; o maestro usa fone. Cada estado tem sua animação (balão ao pensar,
  mão levantada pedindo permissão, fumaça quando falha, comemoração quando o
  critério passa). Ao concluir, o avatar faz uma pausa de 20 a 60 s no
  bebedouro, no café, no fliperama, na sinuca ou conversando, e sai pela
  porta. O monitor de cada PC e a faixa de telas abaixo da sala mostram o que
  o agente faz; clicar abre a conversa. O placar na parede traz tarefas, PRs
  e custo do dia, e o relógio fica vermelho quando um limite estoura. Com o
  painel escondido, a sala e as miniaturas param (ADR 0011).
- **Vault** (SDD 10): notas em Markdown no formato do Obsidian. Clique em
  "Vault" na barra de status para escolher a pasta (a mesma do Obsidian, no
  Mac) ou clonar o repositório git privado (na segunda máquina). Com remoto
  `origin`, o Core sincroniza ao abrir, a cada 2 minutos com mudanças, a cada
  5 minutos sem, e ao fechar; num conflito, fica a versão remota e a local é
  salva como `<nota> (conflito <máquina>).md`. Busca com `Ctrl+Alt+O`
  (`tag:`, `#tag`, `pasta:`), nota de hoje (usa `Templates/Diário.md`),
  backlinks da nota aberta na barra FaKL-Code, playbooks (`Playbooks/` com
  `tipo: playbook`) e "Transformar esta nota em tarefa" no título do editor.
  A prévia de Markdown entende wikilinks, imagens `![[...]]`, callouts e
  diagramas Mermaid. `FaKL: Abrir o grafo do vault` mostra notas e links (a
  nota aberta em destaque, filtro, zoom, clique abre), a view Tags lista as
  tags com as notas de cada uma, e `FaKL: Inserir template do vault` insere
  uma nota de `Templates/` com `{{title}}`, `{{date}}` e `{{time}}`
  preenchidos. Busca semântica (opcional): com
  `vault: { semantica: { provedor: ollama, modelo: nomic-embed-text } }` no
  config.yaml, `FaKL: Busca semântica no vault` acha notas pelo sentido, com
  embeddings calculados no Ollama ou no LM Studio da própria máquina.
  Todo agente ganha as ferramentas `vault_search`, `vault_semantic_search`, `vault_read`,
  `vault_backlinks`, `vault_write` (só em `Agentes/` e `Projetos/`) e
  `vault_append_daily`; notas com `privado: true` ficam fora do alcance
  deles. Cada execução do maestro deixa uma nota em `Agentes/Sessões/`.
- **Acesso remoto** (SDD 12): o ícone de antena na barra de status liga e
  desliga, configura o relay (endereço e chave), testa a conexão com ele
  (`FaKL: Testar conexão com o relay`: HTTPS, WebSocket e chave), mostra o
  QR code para parear um celular e lista os aparelhos, com revogação na hora
  e permissões (ver, decidir, comandar, editor). Cada pareamento pede sua
  confirmação, com a impressão do aparelho. Instalação do relay num VPS:
  `packages/relay/README.md`.
- **GitHub** (SDD 11.1): `FaKL: Entrar no GitHub` usa a conta do GitHub da
  IDE (ou o `gh`, um token ou o device flow). A barra lateral GitHub mostra a
  conta inteira, não só o repositório aberto: Conta (você, organizações e
  repositórios, com busca), Atribuídos a mim, Revisão pedida, Meus PRs, Issues,
  Actions de todos os repos (com filtros) e notificações por repositório, com
  "marcar como lida". PRs têm diff com comentários de revisão na linha,
  aprovar, pedir mudanças e merge, mesmo de repositórios fora do workspace
  (checkout e "Mandar para agentes" oferecem clonar). Os agentes recebem as
  ferramentas `github_*`, incluindo `github_my_prs`, `github_review_requests`
  e `github_recent_runs`; comentar pede sua aprovação. SSO, token fine-grained
  e limites: [`docs/github.md`](../../docs/github.md).
- **Servidores** (SDD 11.2 e 11.3): a barra lateral Servidores lista os hosts
  do `~/.ssh/config`, os criados na IDE e os VPS da Hostinger, com grupos,
  tags e a política dos agentes em cada um (confirmar, leitura, livre,
  bloqueado). Dá para abrir terminal, rodar um comando e abrir uma pasta
  remota (extensão Open Remote - SSH). O painel da Hostinger mostra VPS
  (reinício e snapshot) e domínios com DNS editável. Comandos de escrita de
  agentes num VPS da Hostinger fazem snapshot antes.
- **Lovable** (SDD 11.4): `FaKL: Ligar repositório a um projeto Lovable` e
  `FaKL: Abrir no Lovable`.
- **Segurança** (SDD 14): tokens ficam no cofre do sistema e chegam ao Core só
  em memória; ações sensíveis vão para a auditoria (`FaKL: Auditoria`), e
  segredos são removidos da saída dos agentes e conferidos antes do push.
- **Configuração** (RF-006): `~/.fakl/config.yaml` lista os servidores MCP
  entregues a todo agente (`mcpServers`, com `nome`, `comando`, `args`,
  `env`) e a política de permissão padrão (`permissoes`).

A CLI `fakl` vem junto: a extensão a instala em `~/.fakl/bin` e a põe no PATH
dos terminais da IDE. `fakl tarefa criar "Título" --criterio "pnpm test"
--comecar` cria e começa uma tarefa; `fakl decisoes`, `fakl decidir`,
`fakl custos`, `fakl ssh`, `fakl auditoria` e `fakl --help` mostram o
resto. `git config --global credential.https://github.com.helper "!fakl
git-credential"` faz o git de fora da IDE usar o mesmo login. Para usar fora da IDE,
rode `FaKL: Pôr a CLI fakl no PATH do sistema`.

O Core grava `~/.fakl/run/core.json` com o endereço e o token da sessão,
legível só pelo usuário. É assim que esta extensão e a CLI se conectam.
