# 0012. Adaptador local com laço de ferramentas próprio

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-104; SDD 8.1 e 8.2

## Contexto

O RF-104 pede modelos locais pelo Ollama e pelo LM Studio. Os dois expõem uma
API de chat compatível com a da OpenAI em localhost, com chamada de
ferramentas, mas nenhum traz uma CLI de agente que fale ACP. Alguém precisa
ler e editar arquivos, rodar comandos e chamar as ferramentas MCP da sessão
(o servidor `fakl` do maestro, o vault e as integrações) em nome do modelo.

## Decisão

- **Adaptador `ollama`** em `@fakl/agents`, escolhido pelo perfil
  (`adaptador: ollama`, `provedor: ollama` ou `lmstudio`, `modelo` e um
  `endpoint` opcional). Ele implementa o mesmo `AgentHandle` dos agentes ACP:
  estados, fila de mensagens, pausa, retomada, permissões e uso.
- **Laço de ferramentas no adaptador:** o modelo recebe `read_file`,
  `list_dir`, `search`, `write_file`, `edit_file` e `run_command`, presos ao
  worktree, mais as ferramentas dos servidores MCP da sessão com o nome do
  servidor na frente (`fakl__spawn_agent`). Cada rodada vai até o modelo
  responder sem chamar ferramentas, com teto de 60 passos.
- **Permissões iguais às do ACP:** leitura e busca contam como leitura em
  `aprovar-leitura`; edição e comando perguntam. As ferramentas do servidor
  `fakl` não perguntam aqui, porque o Core já aplica a política e as
  aprovações delas (ADR 0010).
- **Cliente MCP mínimo** (JSON por linha sobre stdio), no mesmo espírito do
  servidor MCP do Core, sem o SDK oficial.
- **Raciocínio:** `reasoning_content`, `reasoning` e o texto entre `<think>`
  viram eventos de pensamento, que a mesa, o chat e o café já mostram.
- **Custo zero:** o uso informa tokens e custo 0 em USD, para o teto diário e
  o placar não estimarem preço de API.

## Consequências

- Qualquer modelo com chamada de ferramentas no Ollama ou no LM Studio vira
  agente, executor ou maestro, sem instalar nada além do servidor local.
- A qualidade depende do modelo; modelos sem suporte a ferramentas respondem
  com erro, que aparece na conversa.
- O adaptador `pty` (CLIs sem ACP) continua adiado: Claude Code, Codex e
  Gemini já entram por ACP, e um pty exigiria o `node-pty` nativo no bundle
  do Core para cada plataforma.

## Alternativas consideradas

- **Rodar uma CLI de agente apontada para o Ollama** (por exemplo, o Codex com
  provedor customizado): dependeria de cada CLI aceitar modelos locais e
  traria a configuração dela junto.
- **SDK oficial do MCP no Core:** mais completo, mas só listar e chamar
  ferramentas não justifica a dependência.
