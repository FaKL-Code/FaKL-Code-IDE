# 0010. Integrações com cofre em memória, ssh do sistema e aprovações no Core

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-501 a RF-509; SDD 11, 14.1 a 14.4
- Adendo: a visão da conta inteira do GitHub está na [0020](0020-github-da-conta-inteira.md)

## Contexto

O M5 dá aos agentes acesso ao GitHub, a servidores por SSH e à Hostinger. São
ações com efeito fora da máquina, iniciadas por modelos que podem ser
induzidos por conteúdo de terceiros. O SDD pede que agentes nunca recebam
segredos, que a política de cada host seja aplicada pelo Core, que ações
sensíveis passem por aprovação e auditoria, e que um login no GitHub valha
para a IDE, o git e os agentes.

## Decisão

- **Cofre em memória:** a extensão guarda os tokens no `SecretStorage` da IDE
  (cifrado pelo `safeStorage`, com Keychain no macOS e DPAPI no Windows) e os
  entrega ao Core por `secrets.set` a cada conexão. O Core nunca grava
  segredos em disco. Só a conexão com o token de sessão da IDE chega a
  `secrets.*` e a `github.gitCredential`; tokens de agente e aparelhos remotos
  não têm esses métodos.
- **Login do GitHub:** a fonte preferida é a conta do GitHub da própria IDE
  (menu Contas), a mesma do git embutido e do sync de configurações, com os
  escopos `repo`, `workflow`, `notifications` e `read:org`. Sem ela, um token
  do `gh auth token`, colado ou do device flow de um OAuth App da FaKL-Code
  (`fakl.github.clientId`). O push do Core recebe o token por `GIT_CONFIG_*`
  (cabeçalho só para github.com), sem tocar o `~/.gitconfig`; fora da IDE,
  `fakl git-credential` serve de credential helper.
- **Pacote `@fakl/integrations`:** clientes do GitHub (REST com ETag), da
  Hostinger e o leitor do `~/.ssh/config` com a classificação de comandos,
  usados pelo Core (ferramentas dos agentes) e pela extensão (painéis). Os
  painéis falam direto com o GitHub com o mesmo token; o Core só intermedeia o
  que agentes fazem.
- **SSH pelo executável do sistema:** `ssh_exec` roda o `ssh` do OpenSSH com
  `BatchMode=yes`, então valem o `~/.ssh/config` (ProxyJump, Include,
  IdentityFile) e o ssh-agent do usuário, sem uma biblioteca SSH no Core.
- **Política por host:** `confirmar` (padrão), `leitura`, `livre` e
  `bloqueado`. A classificação é conservadora: só comandos de uma lista de
  leitura, sem substituição de comando nem redirecionamento para arquivo,
  contam como leitura; padrões destrutivos (`rm -rf`, `DROP TABLE`, `git push
--force`, `reboot` e outros) sempre pedem aprovação. A IDE e a CLI são o
  próprio usuário e não passam pela política, mas ficam na auditoria.
- **Aprovações:** o Core publica o pedido como `agent.permission` da sessão do
  agente, com um id próprio. A IDE, a CLI e o celular já mostram e respondem
  esses pedidos por `agents.permission`, que o Core intercepta. Sem resposta
  em 30 minutos, ou se a sessão terminar, o pedido é negado.
- **Snapshot antes de escrita (RF-508):** um comando de agente que não seja de
  leitura num host ligado a um VPS da Hostinger só roda depois de um snapshot
  pronto. A Hostinger guarda um snapshot por VPS e um novo substitui o
  anterior, então um snapshot feito por este Core há menos de 10 minutos é
  reaproveitado: ele já guarda o estado anterior à sequência de comandos.
- **Auditoria:** `~/.fakl/data/audit.jsonl`, só de inserção, cada linha com o
  hash da anterior. `audit.verify` (e `fakl auditoria --verificar`) aponta a
  primeira linha alterada.
- **Varredura de segredos:** padrões de tokens conhecidos (GitHub, OpenAI,
  Anthropic, AWS, chaves privadas, JWT, senha em URL) e os próprios valores do
  cofre são removidos da saída dos agentes, das notas que eles gravam e das
  notas de sessão; antes do push da entrega, um achado no diff vira decisão.
- **Lovable:** sem API pública, o repositório é ligado ao projeto no
  `config.yaml` (`lovable:`). O maestro recebe esse contexto, e a entrega por
  merge envia o branch acompanhado ao GitHub, que o Lovable sincroniza.

## Consequências

- Fechar a IDE apaga os tokens da memória; o Core só existe com a IDE aberta,
  então nada muda para o usuário.
- A política vale para o que passa pelo Core. Um agente com shell próprio
  ainda pode rodar `ssh` direto se o ssh-agent estiver liberado; a mitigação é
  a permissão do próprio agente (perfil `perguntar`) e um usuário só de
  leitura no servidor, como o SDD recomenda.
- O device flow precisa de um OAuth App registrado pela FaKL-Code; até lá, o
  login pela conta da IDE e o `gh` cobrem o caso.
- A classificação de comandos erra para o lado seguro: comandos de leitura
  pouco comuns pedem aprovação.

## Alternativas consideradas

- **Core cifrando segredos com o safeStorage:** o `utilityProcess` não tem o
  `safeStorage`, e um patch no processo principal só para isso aumentaria a
  superfície do fork. O `SecretStorage` da extensão já usa o `safeStorage`.
- **Biblioteca ssh2 no Core:** exigiria reimplementar o `~/.ssh/config`, o
  ssh-agent no Windows e o ProxyJump; o OpenSSH do sistema já faz isso.
- **Credential helper global no `~/.gitconfig`:** mudaria o git do usuário fora
  da IDE sem pedir; o git embutido da IDE já usa a conta do GitHub.
- **MCP oficial da Hostinger:** expõe a API inteira sem a política de
  confirmação e sem o snapshot antes de escrita; fica como opção do usuário no
  `mcp.json`.
