# 0030. GitHub em tela cheia renderizado pela API

- Status: aceita
- Data: 2026-10-14
- Requisitos: RF-502; SDD 11.1; complementa a ADR 0020

## Contexto

A barra lateral do GitHub ([ADR 0020](0020-github-da-conta-inteira.md)) mostra
a conta inteira em árvores, mas árvores não servem para ler um README, a
conversa de um PR ou o código de um arquivo. O pedido foi uma "janela do
GitHub" dentro da IDE: navegável, mais bonita e fora da barra lateral, sem ser
o navegador embutido.

Embutir o github.com não funciona: o site manda `X-Frame-Options: deny` e
`frame-ancestors 'none'` no CSP, então um iframe fica em branco. O navegador
simples da IDE abre a página, mas pede outro login, não fala com a extensão
(checkout, diff, "Mandar para agentes") e não segue o tema.

## Decisão

- **Painel próprio no editor, dados pela API.** O comando
  `fakl.github.openFull` abre um `WebviewPanel` só, reaproveitado, com
  `retainContextWhenHidden`. A extensão lê a API com o cliente de
  `@fakl/integrations` (com ETag) e manda à webview só o modelo de cada tela.
  O token nunca chega à webview.
- **Rotas internas e histórico na extensão.** Cada tela é uma `Route`
  (início, busca, notificações, perfil, repositório e abas, arquivo, PR,
  issue, execução). Voltar e avançar ficam num `RouteHistory` na extensão;
  links do github.com e links relativos do Markdown viram rotas do painel, e o
  resto abre no navegador do sistema.
- **Markdown renderizado na webview, com lista de permissão.** markdown-it com
  HTML ligado (READMEs usam `<p align>`, `<img>`, `<details>`), depois limpeza
  num documento inerte (`DOMParser`): só tags e atributos conhecidos passam,
  links viram rota, âncora ou link externo, e imagens só com `https:` ou
  `data:image`. Imagens relativas resolvem para `raw.githubusercontent.com` no
  ref do documento.
- **Defesa em camadas.** CSP com `default-src 'none'`, script só com nonce,
  imagens só `https:`/`data:`, sem estilo inline (cores de rótulo e linguagem
  entram pelo CSSOM). Links e imagens são normalizados antes de checar o
  esquema (sem caracteres de controle, então `jav&#x09;ascript:` não passa),
  validados pelo parser de URL contra uma lista (http, https, mailto, âncora,
  rota interna), e só o destino normalizado vai para o DOM. Toda mensagem da
  webview passa por `parseFromWebview` (rotas campo a campo, caminhos sem `..`,
  só URLs `http(s):`/`mailto:`), e as ações valem só sobre o que a própria
  extensão carregou na tela atual; um comentário leva a chave da tela e o
  número do item, e é recusado se a tela mudou.
- **Ações reaproveitadas.** Revisar, merge, checkout, "Mandar para agentes",
  rodar de novo, log do job e diff do arquivo chamam a mesma lógica da barra
  lateral; merge e rodar de novo pedem confirmação modal. Comentar é feito no
  próprio painel, com a resposta (sucesso ou erro) devolvida ao compositor.
- **Ref com `/`.** Uma URL `/blob/feature/auth/a.ts` é ambígua; a extensão
  separa ref e caminho pelo prefixo mais longo que é um branch ou tag do
  repositório.
- **Lógica pura testável.** Rotas, parse de URL, links e imagens relativos,
  validação de mensagens e montagem dos modelos ficam em
  `github-full-model.ts`, sem `vscode`, com testes vitest.

## Consequências

- O painel segue o tema da IDE (claro e escuro) e fala com o resto da
  extensão; o custo é manter telas próprias em vez de herdar o site.
- O Markdown não é idêntico ao do github.com: não há emoji por `:código:`,
  menções viram texto e o realce de sintaxe é o leve do chat. Avisos
  (`> [!NOTE]`), tabelas, listas de tarefa e HTML comum funcionam.
- Imagens relativas de repositórios privados não carregam (pediriam o token
  na webview); o arquivo de imagem nesses repositórios oferece abrir no GitHub.
- Cada tela custa algumas chamadas à API; o ETag faz as repetidas não
  contarem no limite, e a tela inicial usa três buscas (`search` tem limite
  próprio de 30 por minuto).
