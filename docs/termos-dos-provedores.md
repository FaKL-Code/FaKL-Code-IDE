# Termos dos provedores de IA

A FaKL-Code não é afiliada à Anthropic, à OpenAI nem ao Google. Este documento junta o que
cada provedor diz, hoje, sobre usar a conta do usuário em uma ferramenta de terceiros, e o que
a IDE faz a respeito. **Não é aconselhamento jurídico.** Conferido em 2026-10-18; os termos
mudam, e você deve ler os originais antes de depender de qualquer coisa daqui. Onde só achei
relato de terceiros, está escrito.

## Em uma tabela

| Provedor | Como a IDE entra                             | O que a IDE faz                                                                           | Dúvida em aberto                                                                |
| -------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Claude   | `claude-agent-acp` com o login do `claude`   | Só confere se há login, sem copiá-lo; o usuário entra pelo `claude` oficial. Aceita chave | Adaptador feito sobre o Agent SDK usando assinatura: a regra pede chave de API  |
| Codex    | `codex-acp` com `codex login` ou chave       | Só confere se há login, sem copiá-lo. A chave vai para uma pasta própria (ADR 0041)       | Não achei regra específica da OpenAI para clientes ACP                          |
| Gemini   | `gemini --acp` só com chave de API ou Vertex | Não oferece o login Google pessoal; o Doctor avisa                                        | Antigravity (`agy`) por adaptador de terceiros: relatos de suspensão de contas  |
| Locais   | Ollama e LM Studio                           | Fala com o servidor local                                                                 | Vale a licença de cada modelo                                                   |
| Outros   | Qualquer agente ACP que você cadastrar       | Executa o comando que você informou                                                       | Vale o termo do agente e do serviço dele; a responsabilidade é de quem cadastra |

## Claude (Anthropic)

O que a [documentação oficial do Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
diz em "Authentication and credential use", em tradução livre:

- O login por OAuth serve a quem comprou um plano Free, Pro, Max, Team ou Enterprise e foi
  feito para o uso comum do Claude Code e de outros aplicativos nativos da Anthropic.
- **Quem constrói produtos ou serviços que usam as capacidades do Claude, inclusive com o Agent
  SDK, deve usar chave de API** (Claude Console) ou um provedor de nuvem compatível. A Anthropic
  não permite que terceiros ofereçam o login do Claude.ai nos seus aplicativos, nem roteiem
  pedidos pelas credenciais de um plano em nome dos usuários, e os desenvolvedores não podem
  coletar, guardar ou intermediar credenciais ou tokens de sessão: o login precisa se completar
  no fluxo da própria Anthropic.
- O mesmo texto diz que isso **não impede um usuário final de entrar no binário do Claude Code,
  sem modificação, com a própria assinatura**.

O que a FaKL-Code faz: o login é feito pelo `claude` oficial (o botão de login digita
`claude auth login` no terminal, e quem aperta Enter é você); a IDE só confere se há login e não
coleta, não guarda nem repassa o token de sessão; o agente é o
`@agentclientprotocol/claude-agent-acp`, que usa o Claude Agent SDK e o Claude Code da pessoa.

**A dúvida:** esse adaptador é construído sobre o Agent SDK, e a regra acima manda desenvolvedores
de produtos que usam o Agent SDK para a chave de API. Em fevereiro de 2026 houve uma
[discussão no repositório do adaptador](https://github.com/agentclientprotocol/claude-agent-acp/issues/337)
sobre isso; ela foi encerrada em 16/05/2026 com a frase de um mantenedor de que a Anthropic "finalmente
esclareceu", mas não achei esse esclarecimento publicado, e a documentação acima continua
ambígua para esse caso. Relatos de blog dizem que a aplicação da regra variou ao longo de 2026.
**Se você quer zero dúvida, use uma chave de API** (**FaKL: Definir chave de API**, escolhendo o
Claude): o custo vai para a sua conta de API e o uso fica dentro do que a Anthropic descreve.
Para perguntar à Anthropic, o próprio texto indica o contato comercial.

**Nome e logotipo.** A Anthropic permite dizer em texto simples que um produto roda o Claude Code,
mas não usar os nomes ou logotipos dela como parte do nome, do logotipo ou de um modo que
sugira apoio ou parceria. A FaKL-Code usa o nome do provedor em texto para identificar o agente.
Os ícones dos provedores no chat e na Mesa são um ponto a rever com as diretrizes de marca.

## Codex (OpenAI)

A [documentação do Codex](https://developers.openai.com/codex/auth) diz que o Codex aceita entrar
com a assinatura do ChatGPT ou com chave de API, no CLI e na extensão. O adaptador `codex-acp` roda
o Codex da OpenAI (pacote `@openai/codex`) e usa o mesmo login. Não achei, nas fontes consultadas,
uma regra da OpenAI específica para clientes ACP de terceiros. Os
[termos do "Sign in with ChatGPT"](https://openai.com/policies/sign-in-with-chatgpt-terms/) tratam
de aplicativos que se integram a esse login, que não é o caso da IDE (ela não faz o login). Há
relatos de blog de ferramentas que reaproveitam o token do Codex por um proxy local, o que a IDE
não faz.

O que a FaKL-Code faz com chave: guarda no cofre do sistema e, ao usar, o adaptador grava uma
cópia em uma pasta própria (`~/.fakl/accounts/codex-chave`), sem tocar no `~/.codex` com o login
da assinatura. Detalhes na [ADR 0041](adr/0041-chave-de-api-do-codex-em-pasta-propria.md).

## Gemini (Google)

- O login com conta Google pessoal no Gemini CLI foi descontinuado em 18/06/2026 (a
  [página do Google](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals)
  descreve a mudança). Hoje o `gemini` responde "This client is no longer supported for Gemini Code
  Assist for individuals". O plano Google AI Pro não cobre a API.
- A IDE só entra no Gemini por **chave de API** (Google AI Studio) ou Vertex, que seguem
  valendo. Contas Workspace com Standard ou Enterprise mantêm o login, segundo o Google.
- **Antigravity (`agy`) por adaptador de terceiros:** o README do adaptador `agy-acp` cita o FAQ
  do Google dizendo que ferramentas de terceiros para acessar o Antigravity violam os termos e
  podem levar à suspensão da conta, e há [relatos em fórum](https://discuss.ai.google.dev/t/urgent-mass-403-tos-bans-on-gemini-api-antigravity-for-open-source-cli-users-paid-tier/124508)
  de bloqueios 403, inclusive de assinantes. A FaKL-Code **não traz** esse adaptador. Se você o
  cadastrar como agente ACP, o risco é seu e recomendamos uma conta secundária.

## Modelos locais e outros agentes

Ollama e LM Studio rodam na sua máquina; vale a licença de cada modelo. Para qualquer agente ACP
cadastrado à mão, valem os termos do agente e do serviço que ele usa, e a IDE não os verifica.

## O que a IDE nunca faz

- Copiar, guardar ou enviar o token de login de assinatura de nenhum provedor (ela só confere
  se existe um login, para dizer se o agente está pronto).
- Guardar chaves de API fora do cofre do sistema, com a exceção documentada do Codex acima.
- Rotear pedidos de outras pessoas pela sua conta: a IDE é local, e o controle remoto fala com a
  **sua** instalação, pela rede cifrada que você autorizou.
