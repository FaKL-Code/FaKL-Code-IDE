# 0038. Conversas das extensões do Codex e do Claude Code, só para olhar

- Status: aceita
- Data: 2026-10-17

## Contexto

Quem instala os VSIX oficiais do Codex (`openai.chatgpt`) e do Claude Code
(`anthropic.claude-code`) na IDE costuma achar que isso os põe na Mesa, no cyber
café e no Maestro. Não põe: cada extensão tem as suas conversas, dentro do
próprio painel, e o Core não sabe delas.

Ligar de verdade não é possível. Lido nas versões Codex 26.1007 e Claude 2.1.300:

- nenhuma das duas exporta API no `activate()`;
- nenhuma tem comando que envie um prompt a uma conversa. No Claude,
  `claude-vscode.editor.open(sessionId?, initialPrompt?)` e a URI
  `vscode://anthropic.claude-code/open` abrem a sessão e só **pré-preenchem** o
  campo; o Codex tem `chatgpt.newChat`, `chatgpt.newCodexPanel` e
  `chatgpt.openSidebar`, sem argumentos.

O que as duas fazem é guardar o histórico em disco, na mesma pasta que o Core já
usa para os agentes ACP deles (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`).

## Decisão

Mostrar essas conversas na Mesa e no café como **externas** e **somente leitura**.

- O Core ganha o `ExternalSessionsService` (`packages/core/src/external-sessions.ts`),
  que não passa pelo `AgentAdapter` nem pelo `AgentRuntime`: é uma fonte à parte
  de metadados. Métodos: `external.status`, `external.setEnabled`, `external.list`.
- Codex: `<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-*.jsonl`. Conta como da
  extensão o `session_meta` com `originator: codex_vscode`. O `originator:
fakl-code` é o codex-acp do próprio Core e fica de fora, junto com a CLI. O
  título vem do `session_index.jsonl` (`thread_name`).
- Claude Code: `<CLAUDE_CONFIG_DIR>/projects/<pasta>/<sessionId>.jsonl`. Conta
  como da extensão o `entrypoint: claude-vscode`. `sdk-ts` são os agentes do
  Core; `cli` e `claude-desktop` ficam de fora. O título é o `custom-title` ou o
  `agent-name` do fim do arquivo, ou o `name` de `sessions/<pid>.json`.
- Estado: `ativa` se o arquivo mexeu há menos de 2 minutos ou se a sessão viva do
  Claude está `busy` (com o processo existindo); senão `parada`. Aparecem as
  conversas mexidas nos últimos 7 dias, até 20 de cada ferramenta.
- A única ação é **Abrir na extensão**: `claude-vscode.editor.open` com o
  `sessionId` no Claude e `chatgpt.openSidebar` no Codex (que não aceita id).
  Não existe "enviar mensagem" e o Maestro não delega a essas conversas.

### Privacidade

- Desligado por padrão. A chave `sessoesExternas` do `config.yaml` só vira `true`
  depois que o usuário confirma o aviso do comando "FaKL: Mostrar as conversas
  das extensões do Codex e do Claude Code" (ou o botão na Mesa). Sem ela, o Core
  não abre nenhum desses arquivos.
- Só metadados saem do leitor: título, pasta, horário e estado. O texto das
  mensagens não é lido nem mostrado. Título e pasta passam pelo `redact` de
  segredos do Core.
- Os arquivos são abertos só para leitura; o Core nunca grava neles.

### Formato frágil

Os dois formatos são internos e sem documentação, e mudam sem aviso. Por isso o
leitor ignora linha que não é JSON, campo que não tem o tipo esperado e arquivo
que não abre, sem derrubar o Core; se o formato mudar, a lista fica menor ou
vazia, nunca quebrada. Os testes de contrato usam fixtures sintéticas, nunca
conversas reais.

## Consequências

- Quem usa as extensões vê o que está rodando e abre a conversa certa a partir da
  Mesa ou do café, mas não comanda nada por lá. Delegar tarefa continua
  exigindo um agente do Core (ADR 0016).
- Se uma das extensões passar a expor uma API de verdade, esta ADR deve ser
  revista: o ponto de entrada seria um novo `AgentAdapter`, não esta fonte.
- Só a conta padrão do Claude (`CLAUDE_CONFIG_DIR` ou `~/.claude`) é lida; as
  contas lado a lado do ADR 0021 não entram.
- O estado `ativa` do Codex é uma estimativa pelo horário do arquivo; ele não
  guarda um status como o do Claude.
