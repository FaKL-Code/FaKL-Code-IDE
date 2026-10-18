# Build da IDE

A FaKL-Code é compilada com os scripts do VSCodium (ADR 0001). Este repositório
não copia esses scripts: ele fixa a versão deles e aplica a marca por cima.

## Peças

| Arquivo                             | Papel                                                           |
| ----------------------------------- | --------------------------------------------------------------- |
| `upstream/stable.json`              | Versão do Code-OSS (VS Code) usada como base                    |
| `upstream/vscodium.json`            | Versão dos scripts do VSCodium usados para compilar             |
| `upstream/language-pack-pt-br.json` | Versão e SHA-256 do pacote de idioma pt-BR do Open VSX          |
| `branding/product.json`             | Identidade da FaKL-Code: nomes, ids do Windows e do macOS, URLs |
| `branding/logo/`                    | Logo-fonte em SVG                                               |
| `branding/resources/`               | Ícones gerados a partir do logo (commitados)                    |
| `patches/`                          | Patches no core do VS Code, um por área do SDD 5.3              |
| `build/env.sh`                      | Variáveis de marca e quais artefatos gerar                      |
| `build/prepare.sh`                  | Baixa o VSCodium fixado em `.build/` e aplica tudo acima        |
| `build/check-branding.sh`           | Confere a marca na árvore montada, sem compilar                 |
| `build/fetch.sh`                    | Baixa o Code-OSS fixado para `.build/vscodium/vscode`           |
| `build/cache-paths.mjs`             | Lista as `node_modules` do Code-OSS e a chave do cache no CI    |
| `build/build.sh`                    | Compila e gera os instaladores em `.build/vscodium/assets/`     |

## No CI

- `ci.yml` roda `prepare.sh` e `check-branding.sh` em todo PR. Leva segundos.
- `build.yml` compila de verdade e publica os instaladores como artefatos do
  workflow. Só roda quando alguém pede, pelo botão **Run workflow** na aba
  Actions (escolhendo todas as plataformas, só Windows ou só macOS), ou chamado
  pela release. Compila só a arquitetura mais nova de cada sistema: macOS arm64
  (Apple Silicon) e Windows x64.
- Os dois sistemas compilam nos runners hospedados do GitHub (`macos-14` e
  `windows-latest`). O Windows leva perto de duas horas.

Nos runners do GitHub, o build guarda em cache, por sistema e versão do Code-OSS, o cache do npm, o
Electron e os cabeçalhos do node-gyp, além das `node_modules` do Code-OSS com os
módulos nativos já compilados. Com o cache, o `npm ci` vira um `npm install` que
só ajusta o que mudou. A compilação em si (o `gulp`) não tem cache e continua
sendo a maior parte do tempo.

Saídas atuais: `.zip` do app no macOS (assinado ad hoc) e instaladores `.exe`
(por usuário e para o sistema, sem assinatura) e `.zip` no Windows. O `.dmg` e a notarização
dependem de uma conta no Apple Developer Program (SDD 15.2).

## Linux (experimental)

O `build.yml` aceita `plataformas: linux`, que compila no `ubuntu-22.04` (x64) com os scripts do
VSCodium e gera `.tar.gz`, `.deb` e `.rpm`. O `snap` fica de fora: com `CI_BUILD=no` o
`prepare_assets.sh` do VSCodium também o constrói, e o `build.sh` o neutraliza. A opção `todas`
continua sendo só Windows e macOS até o Linux ter passado numa release. O build usa a glibc do
Ubuntu 22.04, então o resultado não roda em distribuições mais antigas que isso (o VSCodium
compila em contêineres com glibc 2.28 para ter mais alcance). No Linux o serviço de atualização
só avisa da versão nova e abre o download; o `fumaca-linux` abre o resultado sob Xvfb.

## Testes fora do Windows

O `ci.yml` roda os testes também no Linux e no macOS (`testes-outros-sistemas`), sem ser requisito
para mesclar, para mostrar o que quebra fora do Windows.

## Releases

O `release.yml` só roda quando alguém pede: **Run workflow** na aba Actions, na
`main`, informando a versão (`v0.1.0`). Ele cria a tag no commit escolhido, roda
o build de todas as plataformas e publica uma GitHub Release **neste repositório**,
com os instaladores e um `SHA256SUMS.txt`. Versões `0.x` saem como pré-release.

## Atualização automática

A IDE se atualiza pelos GitHub Releases (ADR 0037). Três peças:

- **Versão do app.** O `build.yml` passa a tag da release ao `build/versao.mjs`, que
  monta o RELEASE_VERSION do VSCodium: `vX.Y.Z` vira `X*10000 + Y*100 + Z` em seis
  dígitos, sobre a tag do Code-OSS. Tags com sufixo (`v0.2.0-rc1`) e builds manuais
  sem tag usam a versão da data do build e não entram na atualização.
- **Manifestos.** Depois de criar a release, o `release.yml` roda
  `build/manifestos-update.mjs` e publica os `latest.json` na branch `atualizacoes`.
  O `updateUrl` do `branding/product.json` aponta para ela. Cada arquivo leva a URL do
  instalador na release e o SHA-1 e o SHA-256 do arquivo já assinado.
- **Windows nativo, macOS por aviso.** O Windows se atualiza sozinho (instalador por
  usuário, do sistema ou `.zip`, conforme a instalação). O macOS não tem manifesto
  nativo, porque o atualizador dele exige app assinado pela Apple; a extensão
  `fakl-core` lê o `latest.json` da raiz da branch e avisa da versão nova.

| Tag da release | RELEASE_VERSION (Code-OSS 1.135.0) | Versão em **Sobre** |
| -------------- | ---------------------------------- | ------------------- |
| `v0.1.0`       | `1.135.0000100`                    | `1.135.100`         |
| `v0.1.1`       | `1.135.0000101`                    | `1.135.101`         |
| `v0.2.0`       | `1.135.0000200`                    | `1.135.200`         |
| `v1.0.0`       | `1.135.0010000`                    | `1.135.10000`       |

A v0.1.0 saiu antes disso (versão `1.135.06960`, da data) e não se atualiza: a
v0.1.1 em diante sim. Para retirar uma release ruim, reverta o commit dela na
branch `atualizacoes`; o padrão `update.minReleaseAge` de 24 horas dá esse tempo
antes de a IDE aceitar a atualização. A tabela usa o Code-OSS 1.135.0; com outro
só muda o prefixo, e um Code-OSS mais novo sempre conta como versão mais nova.

## Localmente

No macOS, com Node, pnpm, Python 3, jq e git:

```sh
OS_NAME=osx VSCODE_ARCH=arm64 build/build.sh
```

No Windows, pelo Git Bash, com Inno Setup e 7-Zip instalados:

```sh
OS_NAME=windows VSCODE_ARCH=x64 build/build.sh
```

## Extensões embutidas

Cada pasta em `extensions/` com `package.json` vira uma extensão nativa da IDE.
O `prepare.sh` roda `pnpm build`, copia `package.json` (sem dependências),
`dist/`, `README.md` e `LICENSE` para `src/stable/extensions/<nome>` do
VSCodium, e o VS Code a empacota junto com as dele. Por isso a extensão precisa
sair de `dist/` com todas as dependências embutidas (esbuild), menos `vscode`.

## Idioma

A IDE abre em português do Brasil quando o sistema está em qualquer português e
em inglês nos outros casos (ADR 0036). O `prepare.sh` baixa do Open VSX o
pacote `MS-CEINTL.vscode-language-pack-pt-BR` na versão de
`upstream/language-pack-pt-br.json`, confere o SHA-256 e o põe em
`src/stable/extensions/` como extensão nativa, com a licença MIT de
`upstream/language-pack-pt-br.LICENSE.md`. O `check-branding.sh` falha se ele
não estiver na árvore, e o `build.sh` falha se ele não entrar no app compilado.

Sozinho, o VS Code abriria em inglês mesmo com o pacote embutido. O patch
`fakl-idioma-do-sistema.patch` faz o `src/main.ts` escolher o pacote pelo
idioma do sistema quando não há `locale` no `argv.json`. **Configure Display
Language** grava esse `locale` e continua tendo prioridade.

Para atualizar o pacote, troque `version`, `url` e `sha256` juntos. O SHA-256
publicado pelo Open VSX fica ao lado do `.vsix`, com a extensão `.sha256`;
confira com o do arquivo baixado (`sha256sum`).

## Mudando o logo

Edite `branding/logo/fakl-code.svg` (ícone completo, na grade de 1024 do macOS)
e `branding/logo/fakl-code-mark.svg` (marca monocromática do fundo do editor) e
rode `pnpm --filter @fakl/branding icons`. Commite os arquivos gerados.

## Atualizando o VS Code

Toda segunda-feira o workflow `upstream.yml` confere se há versão nova e, se
houver, abre uma issue com o label `upstream` dizendo o que mudar.

Atualize `upstream/stable.json` e, se o VSCodium já tiver uma versão para ela,
`upstream/vscodium.json`. Veja também se o Open VSX tem um pacote de idioma
pt-BR mais novo (seção Idioma). Rode o `build.yml` pelo botão antes do merge.
