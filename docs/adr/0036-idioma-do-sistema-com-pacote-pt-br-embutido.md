# 0036. Idioma do sistema, com o pacote pt-BR embutido

- Status: aceita
- Data: 2026-10-16
- Requisitos: RNF-15
- Substitui: [0014](0014-ingles-da-interface-adiado.md)

## Contexto

A versão open source tem usuários que não falam português. A ADR 0014 adiou o
inglês porque, no VS Code, o idioma padrão é o inglês e o português só aparece
com o pacote de idioma pt-BR instalado e escolhido. Agora as strings da
FaKL-Code são escritas em inglês com tradução pt-BR (pacote `@fakl/i18n`), e
falta a parte do VS Code: menus, paleta de comandos, configurações.

Embutir o pacote `MS-CEINTL.vscode-language-pack-pt-BR` não basta. Sem
`locale` no `argv.json`, o VS Code 1.135:

- no Windows e no Linux passa `--lang en` ao Electron, então `app.getLocale()`
  devolve inglês mesmo com o sistema em português;
- só usa um pacote que esteja no `languagepacks.json` da pasta de dados, e o
  pacote embutido entra nesse arquivo quando o processo compartilhado sobe, ou
  seja, depois que o idioma da primeira janela já foi escolhido.

O resultado seria a IDE sempre em inglês no Windows e a primeira abertura em
inglês no macOS, justamente a da jornada de configuração.

## Decisão

A IDE segue o idioma do sistema: português do Brasil quando o sistema está em
qualquer português, inglês nos outros casos. O pacote de idioma pt-BR do Open
VSX entra no build como extensão nativa, com versão e SHA-256 fixados em
`upstream/language-pack-pt-br.json`. O patch `fakl-idioma-do-sistema.patch`
faz o `src/main.ts`, quando não há `--locale` nem `locale` no `argv.json`,
procurar entre as extensões embutidas um pacote de idioma para o idioma do
sistema e, se achar, registrá-lo no `languagepacks.json` antes de resolver as
traduções.

## Consequências

- Quem tem o sistema em português vê a IDE inteira em português desde a
  primeira abertura; os outros veem inglês, sem aviso para instalar pacote.
- **Configure Display Language** continua valendo: grava `locale` no
  `argv.json`, que tem prioridade sobre o sistema.
- O pacote do Open VSX acompanha o VS Code com atraso (hoje 1.131.0 para o VS
  Code 1.135.0). Textos novos do VS Code aparecem em inglês até sair um pacote
  mais novo; ao atualizar `upstream/stable.json`, confira se há versão nova do
  pacote e atualize versão e SHA-256 juntos.
- O build passa a baixar um arquivo do Open VSX. O SHA-256 fixado impede que
  uma troca no servidor passe despercebida.
- O `.vsix` não traz o texto da licença MIT; ele vai de
  `upstream/language-pack-pt-br.LICENSE.md` para a pasta do pacote.

## Alternativas consideradas

- **Gravar `locale` no `argv.json` na instalação**: fixa o idioma do momento
  da instalação, depende do instalador de cada sistema e não resolve o
  `languagepacks.json` da primeira abertura.
- **`builtInExtensions` no `product.json`**: o build do VS Code baixa pelo
  formato da galeria da Microsoft, e o `product.json` mesclado pelo VSCodium
  substituiria a lista inteira em vez de somar a ela.
- **Montar o pacote a partir do repositório `microsoft/vscode-loc`**: daria a
  mesma versão, com um passo de empacotamento a mais; o Open VSX já publica o
  `.vsix` pronto.
