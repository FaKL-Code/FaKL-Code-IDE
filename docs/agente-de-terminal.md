# Agente de terminal

Um agente de terminal roda qualquer CLI interativa (Aider, uma CLI própria, o Claude Code ou o
Codex no modo normal) dentro de um terminal do VS Code, e a IDE o trata como um agente
qualquer: ele aparece na Mesa e no café, com estados, e o maestro pode mandar mensagens.
A decisão está na [ADR 0047](adr/0047-agente-de-terminal-sobre-o-terminal-do-vscode.md).

## Criar o perfil

Crie `~/.fakl/profiles/aider.yaml`:

```yaml
id: aider
nome: Aider
provedor: aider
adaptador: terminal
comando: aider
args: ['--no-auto-commits']
terminal:
  prompt: '^>\s*$' # regex da linha de prompt da CLI (opcional)
  silencioSegundos: 3 # silêncio para considerar a CLI ociosa (padrão 3)
```

`comando` é obrigatório; `comando` e `args` vêm só do perfil e vão ao terminal como
executável e argumentos separados. Chaves de API não vão no perfil: a CLI usa o login e o
ambiente do terminal.

## Como funciona

1. Ao iniciar o agente, o Core pede à IDE (extensão `fakl-core`) um terminal na pasta do agente
   (o worktree, quando há) e a extensão roda o comando do perfil nele.
2. A extensão lê a saída do terminal pela integração de shell do VS Code, tira os escapes ANSI
   e manda as linhas ao Core, que as publica como saída do agente depois de remover segredos.
3. O estado vem de uma **heurística**: a CLI está ociosa quando fica `silencioSegundos` sem
   escrever e, se o perfil tem `prompt`, a última linha casa com a regex. Pode errar; ajuste o
   `prompt` e o silêncio por perfil.
4. `send_message` do maestro vira `sendText` no terminal, uma linha só, quando a CLI está ociosa.

## Permissões

Um agente de terminal não tem pedidos de permissão estruturados: a CLI pergunta no próprio
terminal. Por isso o Core **só digita nele nos modos `aprovar-tudo` e `autopilot`**, escolhidos
por você. Em `perguntar` e `aprovar-leitura`, a mensagem do maestro é recusada com um aviso, e
você conversa com a CLI pelo comando abaixo. Pedidos de permissão da própria CLI aparecem como
`executando` na Mesa.

## Comandos

- **Assumir o agente** (`fakl.agents.takeOver`): abre e foca o terminal real do agente, para
  você digitar direto. Numa sessão ACP, abre "Continuar no terminal".
- **Continuar no terminal** (`fakl.agents.continueInTerminal`): para agentes ACP do Claude, do
  Codex e do Gemini, abre um terminal na pasta do agente com o comando que retoma a conversa
  na CLI do provedor, **editável antes de executar**:
  - Claude: `claude --resume <id da sessão>` (conferido no `--help`);
  - Gemini: `gemini --resume latest` (conferido; o Gemini não retoma por id);
  - Codex: `codex resume <id>` (**não conferido**, a CLI não estava instalada na verificação).

  Se o agente ainda roda na IDE, a janela pergunta se ele deve parar antes.

Os dois aparecem na paleta ("FaKL: ...") e no menu dos agentes em execução.

## Requisitos e limites

- Integração de shell do VS Code ativa (`terminal.integrated.shellIntegration.enabled`) e um shell
  com suporte: bash, zsh, fish ou PowerShell. Sem ela o agente falha em 15 s com a explicação.
- Precisa de uma janela da IDE conectada ao Core; sem ela, iniciar falha com um aviso.
- Custos e contexto ficam zerados; não há miniaturas de tela.
