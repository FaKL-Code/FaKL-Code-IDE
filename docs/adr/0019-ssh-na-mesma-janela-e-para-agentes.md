# 0019. SSH na mesma janela, como raiz do workspace, e disponível aos agentes

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-504, RF-502, RF-508
- Substitui, em parte: ADR 0018 (itens "abre uma janela nova", "terminal já na
  pasta ao abrir" e "agentes trabalham na pasta padrão deste PC")

## Contexto

A ADR 0018 deu à IDE o `fakl-ssh://<alias>/<caminho>`, mas "Abrir pasta remota"
abria uma janela nova só com o servidor. Quem edita um projeto e precisa mexer
no servidor tinha de trocar de janela, e os agentes iniciados numa janela
remota caíam numa pasta padrão do PC, sem acesso ao servidor.

## Decisão

- **Mesma janela.** "Adicionar servidor SSH ao workspace" usa
  `vscode.workspace.updateWorkspaceFolders` e põe `fakl-ssh://alias/caminho` como
  raiz adicional do workspace multi-root, com o nome `host:caminho`. Nova janela
  deixa de ser o padrão: sobra como segunda opção do QuickPick e como o comando
  "Abrir pasta remota em nova janela".
  - Pasta já adicionada (mesmo com `/` no fim) não duplica: só mostra no
    explorador. Pasta nova entra no fim da lista.
  - Com zero ou uma pasta, a IDE troca o tipo de workspace e pode reiniciar o
    extension host. A pasta já está no workspace, então tudo continua depois
    do reinício; a extensão não guarda estado pendente e avisa antes.
- **Terminal sob demanda.** Nada abre terminal sozinho. O comando "Terminal na
  pasta remota" (árvore, menu do explorador e perfil "SSH (FaKL)") cria ou foca
  um terminal por raiz, já no `cwd` dela. Sair da raiz do workspace fecha o
  terminal e, sem raízes do host, o shell persistente.
- **Aviso de mudança por consulta.** `watch()` consulta a data de modificação
  (mtime) das pastas e arquivos observados a cada 5 s, só com a janela em foco.
  Pasta que mudou é relida e comparada com a lista anterior, e saem eventos de
  criado e apagado. Falhas de rede recuam (até cerca de 1 min) em vez de
  reconectar sem parar. Mudanças em conteúdo de arquivo dentro de uma pasta só
  aparecem se o arquivo está aberto (observado).
- **Reconexão.** O shell persistente já reabria na chamada seguinte; agora uma
  leitura (stat, listar, ler) que pega a conexão caindo reconecta e tenta de novo
  uma vez. Escritas nunca são repetidas sozinhas.
- **ControlMaster.** Fora do Windows, o `ssh` ganha
  `ControlMaster=auto`, `ControlPath=/tmp/fakl-ssh-%C` e `ControlPersist=60`, na
  extensão e no Core, para dividir uma conexão entre pasta, terminal e agentes.
  O OpenSSH do Windows não implementa multiplexação por socket; lá fica
  desligado e cada processo abre a sua conexão (o comportamento anterior).
- **Agentes.**
  - `agents.start` aceita `remotas: [{ host, caminho }]`. O Core põe host e
    caminho no prompt do agente e diz para usar as ferramentas `ssh_*`.
  - A pasta local do agente (e do worktree) é a primeira pasta `file://` do
    workspace, não a primeira pasta qualquer. Sem pasta local, ele segue na pasta
    padrão, e o aviso da sessão diz isso e lista os servidores.
  - Novas ferramentas MCP e métodos do Core: `ssh_read`/`ssh.read`,
    `ssh_write`/`ssh.write`, `ssh_list`/`ssh.list`, `ssh_stat`/`ssh.stat`, e
    `cwd` opcional em `ssh_exec`. Ler, listar e consultar contam como
    **leitura**; gravar conta como **escrita**. Todas passam pela mesma trilha
    do `ssh_exec`: política do host (`policyVerdict`), aprovação, snapshot da
    Hostinger antes de escrita (RF-508) e auditoria. O conteúdo gravado não vai
    para a auditoria, só caminho e tamanho. Agentes não leem nem gravam em
    `~/.ssh` nem em `/etc/shadow` por aqui (barreira simples sobre o caminho
    informado, não uma garantia contra links simbólicos).
  - Leitura e escrita usam `base64` (saída na leitura, entrada padrão na
    escrita), com teto de 5 MiB por chamada. Todo caminho e `cwd` entra no
    `sh` entre aspas simples (`~` vira `"$HOME"`).

## Consequências

- Um projeto local e um ou mais servidores convivem na mesma janela, e o agente
  alcança os dois sem trocar de janela.
- O agente nunca "monta" o servidor: o trabalho remoto é por chamadas
  pontuais, cada uma sujeita à política do host. Não há worktree remoto.
- A multiplexação deixa de abrir uma conexão por chamada em Linux e macOS; no
  Windows o custo de conexão continua.
- A consulta de mudanças custa uma chamada `stat` por item observado a cada 5 s.
- O que a ADR 0018 diz sobre `sh` persistente, `base64`, `stat -c`, ausência de
  busca em arquivos e extensões de linguagem rodando no PC continua valendo.
