# 0041. Chave de API do Codex em pasta própria

- Status: aceita
- Data: 2026-10-18
- Requisitos: RF-103, RF-104

## Contexto

Com uma chave de API no cofre, a IDE deveria entregá-la ao agente do Codex. Não entregava:
`providerCommands().openai.keyAuth.methods` procurava os métodos `openai-api-key` e
`codex-api-key`, e o `codex-acp` 2.x anuncia `api-key` e `chat-gpt`. Sem método
reconhecido, a IDE nunca chamava `authenticate` e o agente seguia com o login que já
existia (ou falhava por falta de login), ignorando a chave.

Medido com o `codex-acp` 2.2.2 num `CODEX_HOME` isolado e uma chave de teste:
`authenticate` com `api-key` lê `OPENAI_API_KEY` do ambiente e grava
`auth.json` (`auth_mode: apikey`) dentro do `CODEX_HOME`. A opção `-c
cli_auth_credentials_store="keyring"` passada ao adaptador não mudou isso: o arquivo foi
gravado do mesmo jeito. No `~/.codex` do usuário, essa gravação apagaria o login da
assinatura (o `auth.json` dele), que só volta com um novo `codex login`.

## Decisão

- O método `api-key` entra na lista de `keyAuth` do Codex, antes dos antigos.
- Com chave no cofre, o agente do Codex recebe um `CODEX_HOME` próprio,
  `~/.fakl/accounts/codex-chave` (criado só para o dono), além da variável da chave. O
  adaptador grava o `auth.json` nessa pasta, e o `~/.codex` com a assinatura fica intacto.
- Quando a chave sai do cofre (**FaKL: Remover chave de API**), o Core apaga o
  `auth.json` da pasta própria.
- O campo de chave do Codex avisa que existe essa cópia, já que o texto geral diz que a
  chave "nunca vai a arquivo".

## Consequências

- A chave do Codex existe em disco, em `auth.json`, dentro de `~/.fakl/accounts/codex-chave`,
  em texto, como o próprio Codex a guarda. O cofre do sistema continua sendo a fonte; a
  cópia é do adaptador. As outras chaves (Claude, Gemini) seguem só no ambiente do agente.
- O Codex em modo chave não vê o que está no `~/.codex`: skills sincronizadas, histórico e
  configuração. Quem usa a assinatura não é afetado.
- Uma chave inválida não é detectada na hora de guardar; o erro vem na primeira conversa.
- Sessões já abertas não trocam de pasta; vale a partir do próximo agente.

## Alternativas consideradas

- **Gravar no `~/.codex`:** sobrescreve o login da assinatura sem o usuário saber.
- **Guardar o `auth.json` no cofre e injetar a cada sessão:** exigiria escrever e apagar o
  arquivo em cada sessão, com o mesmo texto em disco por um tempo e mais partes que podem
  falhar; fica como evolução se a cópia fixa incomodar.
- **`cli_auth_credentials_store="keyring"`:** não teve efeito no adaptador medido.
