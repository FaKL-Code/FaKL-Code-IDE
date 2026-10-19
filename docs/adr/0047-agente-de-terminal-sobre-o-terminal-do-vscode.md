# 0047. Agente de terminal interativo sobre o terminal do VS Code

- Status: aceita
- Data: 2026-10-18
- Requisitos: RF-103, RF-105; SDD 8.2 e 8.4

## Contexto

O RF-103 pede "qualquer agente ACP ou qualquer CLI de terminal por um adaptador genérico", e
o SDD previa um adaptador `pty`. Hoje só existem ACP e Ollama; a ADR 0012 adiou o PTY e a ADR
0046 entregou só um terminal de leitura. Faltam duas coisas: rodar uma CLI interativa que não
fala ACP (Aider e semelhantes) como agente da Mesa, e deixar o usuário digitar direto na CLI
de um agente.

Um PTY próprio exigiria `node-pty` (módulo nativo para o Electron em três sistemas, a cada
atualização do upstream), e isso foi descartado. Mas o VS Code já tem PTY real: o terminal
integrado. Desde a 1.93 a API estável de integração de shell da extensão
(`terminal.shellIntegration.executeCommand(executável, args)`, `TerminalShellExecution.read()`,
`onDidEndTerminalShellExecution`) lê a saída bruta de um programa que roda nele, e
`terminal.sendText` envia teclas. O Code-OSS da base é o 1.135.0 (`upstream/stable.json`).

O PTY vive no processo da extensão; o Core é outro processo e não alcança o terminal da IDE.

## Decisão

Um adaptador de agente cujo runtime é um terminal do VS Code, com uma ponte entre a extensão
`fakl-core` e o Core pela API local que já existe.

- **Perfil.** `adaptador: terminal` (`AGENT_ADAPTERS`), obrigatoriamente com `comando`; `args`
  e `env` valem como nos outros perfis. O bloco `terminal:` ajusta a heurística de ocioso:
  `prompt` (regex da linha de prompt) e `silencioSegundos` (padrão 3). O `comando` e os
  `args` vão ao terminal separados (`executeCommand(executável, args)`), sem montagem de
  texto de shell; nada que o agente escreve vira comando.
- **Ponte.** A extensão se registra no Core com `agents.terminalHost.register` (dizendo que
  terminais ainda mantém) e passa a receber a notificação `agents.terminalHost.command`:
  `spawn` (criar o terminal na pasta do agente e rodar o comando do perfil), `input` (uma linha
  de texto) e `stop` (fechar). De volta, ela chama `agents.terminalHost.ready|output|state|exit`.
  Só a conexão registrada pode relatar; conexões com token restrito (agentes, celular) não
  alcançam esses métodos. Se a IDE se registrar de novo sem um terminal que o Core conhecia,
  a sessão falha; se a conexão cair, há 30 s de tolerância.
- **Sessão normal.** O Core (`packages/core/src/terminal-host.ts`) entrega ao
  `AgentRuntime` um `TerminalAdapter` (`packages/agents/src/terminal`). A sessão aparece na
  Mesa e no café, com estados, e `usage()` é sempre zero (não há como saber custo ou
  contexto de uma CLI qualquer). Sem nenhuma IDE conectada, iniciar falha com uma mensagem
  clara; um perfil de terminal nunca é escolhido como maestro (não recebe as ferramentas MCP).
- **Saída.** A extensão transforma o fluxo bruto em linhas (parser simples de ANSI: cor e
  título somem, `\r`, `\b` e `ESC[K` mexem na linha, o resto é ignorado) e manda ao Core em
  lotes. O Core a publica como `agent.output`, passando pelo `redact` de segredos como toda
  saída de agente.
- **Pronto ou ocioso (heurística).** A CLI conta como ociosa quando fica `silencioSegundos`
  sem escrever e, se o perfil define `prompt`, a linha em andamento casa com a regex. Texto
  novo (ou algo digitado) a devolve a `executando`. Isto é uma **heurística**: uma CLI que
  pensa em silêncio parece ociosa, e uma que pergunta algo sem casar o prompt parece ocupada.
  O estado fica `preparando` até a primeira vez que a CLI fica ociosa. `send_message` espera
  a CLI ficar ociosa (mensagens enfileiram) e a rodada termina quando ela volta a esperar.
- **Segurança de entrada.** Sem ACP não há pedido de permissão estruturado: a CLI pergunta no
  próprio terminal, onde o Core não enxerga nem responde (`respondPermission` sempre recusa).
  A política mais conservadora: o Core só digita no terminal nos modos `aprovar-tudo` e
  `autopilot`, escolhidos de forma explícita pelo usuário; em `perguntar` e `aprovar-leitura`
  a mensagem é recusada com um erro que explica e manda usar "Assumir o agente". Baixar o modo
  tira da fila o que ainda não foi digitado. O texto enviado é uma linha só, sem escapes nem
  controles (quebras viram espaço: um Enter no meio enviaria a mensagem em pedaços, ou
  executaria cada pedaço como comando de shell se a CLI já tivesse saído); a extensão limpa de
  novo. Entrada do próprio usuário, no terminal, nunca passa pelo Core.
- **Assumir o agente** (`fakl.agents.takeOver`). Para um agente de terminal, traz à frente o
  terminal real, onde o usuário digita direto. Para um agente ACP, cai em "Continuar no terminal".
- **Continuar no terminal** (`fakl.agents.continueInTerminal`). Abre um terminal na pasta do
  agente com o comando que retoma a mesma conversa na CLI do provedor, **editável antes de
  executar**: `claude --resume <id>` e `gemini --resume latest` foram conferidos nos `--help`
  das versões instaladas na verificação (o Gemini retoma por `latest` ou índice, não pelo id
  ACP). `codex resume <id>` **não foi conferido** (CLI ausente na máquina de verificação) e o
  id da sessão ACP pode não ser o do CLI; o texto avisa. Se o agente ainda roda na IDE, a
  janela pergunta se o para antes, para dois programas não escreverem na mesma conversa.

## Limites conhecidos

- Exige a integração de shell do VS Code (bash, zsh, fish, PowerShell; `cmd` não). Sem ela
  o agente falha em 15 s com a explicação, em vez de rodar sem ser lido.
- `executeCommand(executável, args)` cita os argumentos só para separar palavras, não como
  barreira de segurança: argumentos de perfil com `$(...)` ou crases podem ser expandidos
  pelo shell. Os argumentos são do perfil, que é do usuário.
- Pedidos de permissão que a CLI faz no terminal aparecem como `executando`: o Core não os
  distingue de trabalho. Quem delega com `aprovar-tudo` aceita isso.
- A extração de linhas aproxima o que se vê; telas redesenhadas por completo (TUI cheia)
  saem como ruído. Não há emulador (`@xterm/headless`), nem miniatura.
- Depois de reiniciar o Core, uma sessão de terminal antiga volta retomável, mas retomar
  inicia a CLI de novo, sem o histórico dela.
- Não houve teste na IDE compilada; ver o PR.

## Consequências

- O RF-103 passa a cobrir CLIs sem ACP; o RF-105 ganha terminal interativo para esses
  agentes, e todo agente ACP de Claude, Codex e Gemini ganha um caminho para a CLI real.
- Nenhum módulo nativo: a parte de PTY é o terminal do VS Code.
- A lógica de linhas, ocioso, política e comando é pura (`@fakl/agents`), testada sem VS Code;
  o hospedeiro é testado contra um terminal falso injetado.
