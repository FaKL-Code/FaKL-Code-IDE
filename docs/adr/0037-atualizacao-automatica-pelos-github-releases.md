# 0037. Atualização automática pelos GitHub Releases

- Status: aceita
- Data: 2026-10-17
- Requisitos: RF-003

## Contexto

O RF-003 pede que a IDE se atualize sozinha a partir dos GitHub Releases. Até a
v0.1.0 o serviço de update ficou desligado (`DISABLE_UPDATE=yes`): o repositório
era privado e os binários não ficavam em lugar público. Agora o repositório e as
releases são públicos, e quem instala a IDE fica na versão que baixou: sem
atualização, uma correção só chega a quem baixa o instalador de novo.

O VSCodium já traz o serviço: um patch troca a API de atualização da Microsoft
por arquivos estáticos em `<updateUrl>/<qualidade>/<plataforma>/<arquitetura>[/<alvo>]/latest.json`.
O serviço compara o `productVersion` do arquivo com a versão do app, baixa o
instalador da `url` e confere o `sha256hash`.

Três pontos não vêm prontos:

- **Onde ficam os manifestos.** O VSCodium usa um repositório `versions` à parte.
- **A versão do app.** Os scripts do VSCodium a montam com a data do build (dia do
  ano e hora), que volta ao começo todo ano e não diz qual release é a mais nova.
- **macOS.** O atualizador do macOS (Squirrel.Mac) exige app assinado com um
  certificado da Apple, e o nosso sai com assinatura ad hoc (`docs/assinatura.md`).

## Decisão

- O `updateUrl` do `branding/product.json` aponta para a branch `atualizacoes`
  deste repositório, servida por `raw.githubusercontent.com`. O `DISABLE_UPDATE`
  passa a `no`. A cada release, o `release.yml` gera os manifestos com
  `build/manifestos-update.mjs` (SHA-1 e SHA-256 do instalador final, já
  assinado) e os publica nessa branch, depois de criar a release.
- A versão do app sai da tag (`build/versao.mjs`): `vX.Y.Z` vira o RELEASE_VERSION
  do VSCodium com `X*10000 + Y*100 + Z`, em seis dígitos (quatro desde a ADR 0054), sobre a tag do Code-OSS
  (`v0.1.1` com Code-OSS 1.135.0 dá `1.135.0000101`, e o app mostra `1.135.101`).
  Cresce a cada release e entre versões do Code-OSS. Tags com sufixo (`-rc1`) não
  entram na atualização; esse build leva a versão da data.
- **Windows:** atualização nativa, pelos três alvos do updater (instalador por
  usuário, instalador do sistema e `.zip`).
- **macOS:** sem manifesto nativo. A extensão `fakl-core` lê o `latest.json` da
  raiz da branch e avisa que há versão nova, com o botão de baixar. Quando o app
  tiver notarização, o macOS ganha o manifesto nativo e esse aviso sai.
- O padrão `update.minReleaseAge` (do patch do VSCodium) fica em 24 horas, em vez
  das 120 do VSCodium: dá tempo de retirar uma release ruim apagando o manifesto,
  sem atrasar correções por cinco dias.

## Consequências

- A primeira versão com atualização é a seguinte à v0.1.0: quem tem a v0.1.0
  instala a nova uma vez à mão, e daí em diante o app se atualiza.
- A versão que a IDE mostra em **Sobre** é `1.135.101`, não `0.1.1`; o mapa entre
  as duas está em `docs/build.md`.
- Para retirar uma release, apague ou reverta os manifestos na branch
  `atualizacoes`; os instaladores continuam na release.
- Cada IDE aberta consulta o GitHub (um GET em `raw.githubusercontent.com`) de
  tempos em tempos; a FaKL-Code não tem servidor nesse caminho. Quem quiser
  desliga com `update.mode: none`.
- O Windows segue sem assinatura (o SignPath Foundation recusou o projeto); a
  atualização baixa o mesmo instalador da página de downloads e confere o
  SHA-256 do manifesto antes de instalar.

## Alternativas consideradas

- **Repositório `versions` à parte, como o VSCodium:** mais um repositório e um
  token com escrita para o `release.yml`; a branch do próprio repositório usa o
  `GITHUB_TOKEN`.
- **Manifestos no site da IDE:** acopla a atualização ao deploy do
  site e a um domínio, em vez de ao GitHub, de onde os instaladores já vêm.
- **Manter a versão da data:** o salto de ano faria a versão nova parecer mais
  velha que a instalada.
- **Atualizador nativo no macOS com assinatura ad hoc:** o Squirrel.Mac confere a
  assinatura do app novo contra a do instalado, e a ad hoc não serve; sem teste
  de ponta a ponta, o risco é um erro a cada verificação.
