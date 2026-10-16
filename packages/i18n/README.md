# @fakl/i18n

Idioma da interface da FaKL-Code: inglês e português (Brasil). O texto de
origem fica em **inglês no código**, como no VS Code; o pt-BR vem dos catálogos
deste pacote. Qualquer idioma sem catálogo mostra o inglês do código.

Comentários, nomes internos, commits e ADRs continuam em pt-BR: só o que a
pessoa vê na tela é traduzido.

## Escrever um texto

```ts
import { l10n } from '@fakl/i18n';

l10n.t('Install');
l10n.t('Signed in as {0}.', user);
count === 1 ? l10n.t('1 host available.') : l10n.t('{0} hosts available.', count);
```

- Sempre `l10n.t('...')` com o texto literal (é ele que a checagem extrai).
  Nada de montar frase concatenando pedaços traduzidos: use `{0}`, `{1}`.
- Plural: uma mensagem para 1 e outra para N.
- Nunca chame `l10n.t` no topo do módulo (constante): o idioma é escolhido
  depois, em `useLocale`. Monte listas de textos dentro de funções.
- Inglês americano, frases curtas, sem ponto final em botão. Nomes de produto
  (Claude, Codex, Gemini, GitHub, Hostinger, Lovable, VS Code, FaKL Noite) não
  se traduzem.
- Na extensão, use este `l10n` (não o `vscode.l10n`): o mesmo texto funciona no
  host, nos webviews e nos modelos puros, que são testados sem VS Code.

## Escolher o idioma (`useLocale`)

Cada ponto de entrada chama `useLocale` uma vez, antes de mostrar texto:

| Onde                   | Idioma                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Extensões (`activate`) | `vscode.env.language`                                                              |
| Webviews               | `document.documentElement.lang`; o host põe `<html lang="${vscode.env.language}">` |
| App do celular         | `navigator.language`                                                               |
| Overlay                | o da IDE, vindo do Core; sem ele, `navigator.language`                             |
| Core                   | o da IDE (a extensão informa ao conectar); antes disso, `localeFromEnv`            |
| CLI                    | `localeFromEnv(process.env)`: `FAKL_LOCALE`, `LC_ALL`, `LC_MESSAGES`, `LANG`, Intl |

## Catálogos

Um arquivo por área em `src/catalogos/pt-br/`, para áreas diferentes não
disputarem o mesmo arquivo. A chave é o texto em inglês; o valor, o pt-BR. A
mesma chave em duas áreas precisa ter o mesmo texto.

| Arquivo         | Código                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `extensao.json` | `extensions/*/src`, menos webviews e jornada                                                                            |
| `webviews.json` | `extensions/fakl-core/src/webview`, menos a jornada                                                                     |
| `jornada.json`  | jornada de configuração (`setup*.ts`, `webview/setup.ts`)                                                               |
| `pwa.json`      | `apps/remote-pwa`                                                                                                       |
| `overlay.json`  | `apps/overlay`                                                                                                          |
| `core.json`     | `packages/core`, inclusive os prompts dos agentes                                                                       |
| `cli.json`      | `packages/cli`                                                                                                          |
| `pacotes.json`  | os demais pacotes (`agents`, `voz`, `cafe`, `conversa`, `remote`, `relay`, `integrations`, `settings-sync`, `protocol`) |

Os manifestos das extensões usam o mecanismo do VS Code: `%chave%` no
`package.json`, o inglês em `package.nls.json` e o pt-BR em
`package.nls.pt-br.json`. Chaves no formato `command.<id>`,
`view.<id>`, `config.<chave>`, `walkthrough.<id>.<etapa>.title`.

## Conferir

```sh
pnpm check:l10n                      # roda também no pnpm check e no CI
node build/l10n.mjs --faltando       # chaves do código ainda sem pt-BR
```

A checagem falha com texto sem pt-BR, tradução que o código não usa mais,
placeholders diferentes entre inglês e pt-BR, e `%chave%` faltando ou sobrando
nos `package.nls*.json`.

Testes afirmam o inglês (o idioma padrão). Para testar o pt-BR, chame
`useLocale('pt-br')` no teste e volte com `useLocale('en')` no `afterEach`.

## Glossário

Use sempre o mesmo termo nos dois idiomas.

| pt-BR                                                  | Inglês                                        |
| ------------------------------------------------------ | --------------------------------------------- |
| Mesa                                                   | Desk                                          |
| maestro                                                | maestro                                       |
| tarefa                                                 | task                                          |
| execução                                               | run                                           |
| rodada                                                 | round                                         |
| critério de pronto                                     | done criteria                                 |
| entrega                                                | delivery                                      |
| decisão                                                | decision                                      |
| perfil                                                 | profile                                       |
| provedor                                               | provider                                      |
| teto diário / teto de gasto                            | daily cap / spending cap                      |
| janela de uso                                          | usage window                                  |
| Recursos de IA                                         | AI Resources                                  |
| fonte de recursos                                      | resource source                               |
| vault                                                  | vault                                         |
| nota diária                                            | daily note                                    |
| cyber café                                             | cyber café                                    |
| controle remoto                                        | remote control                                |
| aparelho                                               | device                                        |
| parear / pareamento                                    | pair / pairing                                |
| cofre do sistema                                       | system keychain                               |
| modo minimizado                                        | minimized mode                                |
| jornada de configuração                                | setup journey                                 |
| Perguntar / Aprovar leitura / Aprovar tudo / Autopilot | Ask / Approve reads / Approve all / Autopilot |
| conta Claude                                           | Claude account                                |
| comandos por voz                                       | voice commands                                |
