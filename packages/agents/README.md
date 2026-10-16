# @fakl/agents

Runtime de agentes do FaKL Core (SDD seção 8).

- `AgentAdapter` e `AgentHandle`: o contrato que o orquestrador usa sem saber
  qual provedor está do outro lado.
- `AcpAdapter`: roda um agente ACP como processo filho e conversa por JSON-RPC
  no stdio, com o SDK oficial `@agentclientprotocol/sdk`. Mapeia as
  atualizações do agente para os estados da seção 8.3, aplica a política de
  permissões e limita leitura e escrita de arquivos ao worktree.
- `adapterForProfile`: Claude Code (`claude-agent-acp`), com perfis Haiku,
  Sonnet e Opus por nível de custo, Codex (`codex-acp`) e Gemini CLI
  (`gemini --acp`) por padrão; qualquer outro agente ACP pelo `comando` do
  perfil (RF-103).
- `LocalAdapter` (`adaptador: ollama`): modelos do Ollama ou do LM Studio
  pela API compatível com OpenAI, com o laço de ferramentas no próprio
  adaptador (arquivos do worktree, busca, comandos e as ferramentas MCP da
  sessão) e as mesmas permissões dos agentes ACP (ADR 0012).
- O agente recebe só as variáveis de ambiente da lista em `src/env.ts`.

O login é o de cada CLI. Quando falta, `start` falha com a instrução de login
do provedor.
