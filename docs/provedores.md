# Provedores de IA

A FaKL-Code não exige nenhuma assinatura. Ela usa o que estiver pronto na
máquina, em qualquer combinação, e funciona sem IA nenhuma
([ADR 0035](adr/0035-provedores-de-ia-detectados.md)).

| Provedor            | Como entra                                       | Agente                                          |
| ------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Claude (Anthropic)  | login do Claude Code ou `ANTHROPIC_API_KEY`      | `claude-agent-acp`                              |
| Codex (OpenAI)      | `codex login` ou `OPENAI_API_KEY`                | `codex-acp`                                     |
| Gemini (Google)     | login do Gemini CLI ou `GEMINI_API_KEY`          | `gemini --acp`                                  |
| Ollama / LM Studio  | servidor local ligado, com um modelo de conversa | adaptador local da IDE                          |
| Qualquer agente ACP | o login do próprio agente, ou uma chave          | o comando cadastrado (OpenCode, Qwen Code, ...) |

## Na IDE

- **FaKL: Provedores de IA** mostra o que está pronto, por qual modo
  (assinatura, chave, local ou ACP), e oferece no terminal o comando que falta
  (instalar ou fazer login), sem rodá-lo por você.
- **FaKL: Definir chave de API** guarda a chave no cofre do sistema. Ela vai
  só ao agente daquele provedor, nunca a arquivo ou log, e vence o login da
  assinatura enquanto estiver guardada. Uma chave que só existe no ambiente do
  shell não chega aos agentes. **FaKL: Remover chave de API** desfaz.
- **FaKL: Cadastrar agente ACP** registra um agente de terceiros com comando,
  argumentos, variáveis (sem segredos) e, se ele usar chave, o nome da
  variável que a recebe.

## Perfis

Na primeira abertura, a IDE grava em `~/.fakl/profiles` só os perfis dos
provedores prontos. Ao guardar uma chave ou cadastrar um agente, os perfis
daquele provedor são criados. Um perfil seu nunca é sobrescrito, e perfis que
você apagou não voltam sozinhos.

## Janelas de uso

A barra de status mostra a sessão de 5 horas e a semana do Claude e do Codex,
e a cota diária do Gemini (requisições desde a meia-noite do Pacífico). Para
ver percentuais, informe os tetos do seu plano em `fakl.limits.providers`:

```json
{
  "fakl.limits.providers": {
    "anthropic": { "sessionTokens": 2000000, "weeklyTokens": 40000000 },
    "google": { "dailyRequests": 1000 }
  }
}
```

`fakl.limits.claude.sessionTokens` e `weeklyTokens` continuam valendo para o
Claude. Um provedor configurado sem registro de uso aparece como "sem dados".

## Para a jornada de configuração

O Core expõe:

- `providers.detect` → `{ provedores: ProviderStatus[] }`: por provedor,
  `instalado`, `caminho`, `versao`, `logado`, `chave`, `chaveEnv`, `modo`,
  `pronto`, `instalar`, `login`, `modelos` (locais), `perfis` e `aviso`.
- `providers.generateProfiles` (`{ provedores?: string[] }`) → perfis criados.
- `providers.acp.add` (`ProviderAcpAddParams`) → o perfil do agente ACP.
- `secrets.set` com `apikey.<provedor>`: só a IDE chama.

Os tipos ficam em `packages/protocol/src/providers.ts`.
