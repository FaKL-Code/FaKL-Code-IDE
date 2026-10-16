# 0035. Provedores de IA detectados, não presumidos

- Status: aceita
- Data: 2026-10-15
- Requisitos: RF-103, RF-104; SDD 7, 8.2, 9.1
- Complementa: [0026](0026-janelas-de-uso-dos-planos.md)

## Contexto

A IDE nasceu presumindo as três assinaturas (Claude, Codex e Gemini): sete
perfis fixos eram gravados em `~/.fakl/profiles` na primeira abertura, o guia
do maestro citava modelos de todos os provedores e pedia revisão cruzada
Claude ↔ Codex, as janelas de uso só cobriam Claude e Codex e a marca do
agente vinha de um pedaço do id do perfil. Na versão open source, cada pessoa
tem uma combinação diferente: só um provedor, só uma chave de API, só um
modelo local, um agente ACP de terceiros, várias coisas ao mesmo tempo ou
nenhuma.

## Decisão

- **Detecção no Core (`providers.detect`).** Para cada provedor: instalado,
  caminho, versão (`--version` do CLI), logado, chave no cofre, modo
  (`assinatura`, `chave`, `local` ou `acp`), pronto, comando de instalação e
  de login, perfis que já o usam e um aviso do que falta. O login é conferido
  pelo que cada CLI grava (`.credentials.json` ou `oauthAccount` do Claude,
  `auth.json` do Codex, `oauth_creds.json` do Gemini), só pela existência; no
  macOS, onde o Claude usa o Keychain, vale `claude auth status`. Servidores
  locais (Ollama e LM Studio) respondem em `/v1/models`. A jornada de
  configuração consome este método.
- **Perfis gerados.** A primeira abertura grava só os perfis dos provedores
  prontos (`providers.generateProfiles`); os de fábrica ficam agrupados por
  provedor em `PROVIDER_PROFILES`, e um servidor local ganha um perfil com o
  modelo de programar que ele tiver. Perfil existente nunca é sobrescrito; um
  provedor que já ganhou perfis não volta sozinho se o usuário apagá-los
  (`~/.fakl/data/providers.json`), só a pedido explícito (chave nova, jornada).
  Sem provedor, a IDE abre sem perfis e funciona sem IA.
- **Chave de API pelo cofre.** A extensão guarda a chave no SecretStorage
  (`fakl.apikey.<provedor>`), entrega ao Core em `secrets.set`
  (`apikey.<provedor>`) a cada conexão, e o Core a injeta só no processo do
  agente daquele provedor (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY` ou a `chaveEnv` de um agente ACP). Chave guardada vence o
  login da assinatura; quando o agente anuncia um método de login por chave
  no ACP (`gemini-api-key`, `openai-api-key`), a sessão o pede. O ambiente do
  shell continua filtrado: uma chave só no shell não chega ao agente, e a
  detecção avisa.
- **Agentes ACP cadastrados.** `providers.acp.add` grava um perfil com
  `comando`, `args`, `env` (sem segredos) e `chaveEnv`; o id dele vira o
  provedor. OpenCode e Qwen Code vêm prontos no comando da IDE.
- **Maestro adaptável.** O guia de escolha de perfil é montado com os perfis
  reais: níveis de custo, pontos fortes, revisão cruzada só com dois ou mais
  provedores (senão, outro perfil do mesmo provedor, ou o próprio perfil
  revisando). O maestro padrão é um perfil instalado que pode ser maestro, de
  preferência de CLI. Sem provedor, `runs.start` recusa com uma mensagem que
  diz como ligar um. O perfil sugerido por um recurso que não existe aqui cai
  para um parente (`claude-sonnet` → `claude`) ou para o de quem delega.
- **Janelas do Gemini.** O Gemini CLI grava cada resposta com tokens em
  `~/.gemini/tmp/<projeto>/chats/session-*.jsonl`. A cota dele é diária (zera
  à meia-noite do Pacífico): a janela `dia` traz requisições e tokens. Provedor
  de plano com perfil e sem registro aparece como "sem dados". A barra de
  status da extensão passa a ler `usage.windows` do Core, como o overlay, e os
  tetos são por provedor (`fakl.limits.providers`); `fakl.limits.claude.*`
  continua valendo para o Claude.
- **Marca pelo provedor.** Overlay, celular e chat usam o campo `provedor` do
  perfil (que `AgentSessionInfo` passa a trazer), nunca o id.

## Consequências

- Quem tem só um provedor recebe só os perfis dele, e nenhum texto do maestro
  fala de modelos que ele não tem.
- O Core passa a rodar `--version` e, no macOS, `claude auth status` ao
  detectar; a primeira abertura pula a versão.
- A chave de API existe só na memória do Core e no ambiente do processo do
  agente; os textos dos agentes passam pela redação de segredos como antes.

## Alternativas

- **Herdar as chaves do shell.** Mais simples, mas quebra a regra de que
  segredo só entra pelo cofre (SDD 8.4) e mandaria a chave a todo agente.
- **Gerar perfis a cada abertura.** Recriaria perfis que o usuário apagou de
  propósito.
