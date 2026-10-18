# Provedores de IA

A FaKL-Code não exige nenhuma assinatura. Ela usa o que estiver pronto na
máquina, em qualquer combinação, e funciona sem IA nenhuma
([ADR 0035](adr/0035-provedores-de-ia-detectados.md)).

| Provedor            | Como entra                                       | Agente                                          |
| ------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Claude (Anthropic)  | login do Claude Code ou `ANTHROPIC_API_KEY`      | `claude-agent-acp`                              |
| Codex (OpenAI)      | `codex login` ou `OPENAI_API_KEY`                | `codex-acp`                                     |
| Gemini (Google)     | chave de API (`GEMINI_API_KEY`) ou Vertex        | `gemini --acp`                                  |
| Ollama / LM Studio  | servidor local ligado, com um modelo de conversa | adaptador local da IDE                          |
| Qualquer agente ACP | o login do próprio agente, ou uma chave          | o comando cadastrado (OpenCode, Qwen Code, ...) |

### Codex com chave de API

A chave fica no cofre do sistema, como as outras. Mas o `codex-acp` precisa dela num
`auth.json` e, se escrevesse em `~/.codex`, apagaria o seu login da assinatura. Por isso,
com uma chave guardada, o agente do Codex roda com um `CODEX_HOME` próprio,
`~/.fakl/accounts/codex-chave`, onde o adaptador grava essa cópia. O `~/.codex` e o login
da assinatura não são tocados, e **FaKL: Remover chave de API** apaga a cópia. A pasta
própria não tem as skills do `~/.codex`, então o Codex em modo chave não as vê.
([ADR 0041](adr/0041-chave-de-api-do-codex-em-pasta-propria.md))

### Gemini: só com chave de API

Desde junho de 2026 o Google não aceita mais o login com conta Google pessoal no
Gemini CLI para uso fora dos produtos dele: o `gemini` responde "This client is no longer
supported for Gemini Code Assist for individuals". O plano Google AI Pro não muda isso, e
também não cobre a API. O que funciona:

1. Crie uma chave no [Google AI Studio](https://aistudio.google.com/apikey). Confira lá se a
   conta tem cota gratuita ou se precisa ligar o faturamento.
2. Rode **FaKL: Definir chave de API**, escolha Gemini e cole a chave.

Contas Workspace com Standard ou Enterprise e as credenciais do Vertex AI continuam
valendo. O **FaKL: Doctor** avisa quando o Gemini está num login que o Google não aceita.

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
