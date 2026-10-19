# Distribuição

Onde baixar a FaKL-Code e como cada canal é mantido. A fonte de tudo são as
[GitHub Releases](https://github.com/FaKL-Code/FaKL-Code-IDE/releases); os gerenciadores de pacote só
apontam para os arquivos de lá. O Windows não é assinado e o macOS é só ad hoc, sem notarização
([assinatura](assinatura.md)), o que pesa em quase todos os canais abaixo.

| Canal                                            | Plataforma  | Instalar                                                                                           | Estado                                                              |
| ------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Releases e site                                  | Win e macOS | Baixar o `.exe` ou o `.zip` na página de downloads do site da IDE                                  | Em uso                                                              |
| winget                                           | Windows     | `winget install FaKLCode.FaKLCode`                                                                 | Manifesto validado com `winget validate`; PR enviado ao winget-pkgs |
| Scoop (bucket próprio)                           | Windows     | `scoop bucket add fakl-code https://github.com/FaKL-Code/scoop-bucket` e `scoop install fakl-code` | Manifesto gerado; instalação não testada                            |
| Homebrew (tap próprio)                           | macOS arm64 | `brew install --cask fakl-code/tap/fakl-code`                                                      | Cask gerado; instalação não testada (não há Mac aqui)               |
| Linux                                            | x64         | `.tar.gz`, `.deb` e `.rpm` da release                                                              | Experimental, validado só no CI                                     |
| Homebrew oficial, Chocolatey, Flathub, Snap, AUR | vários      | Não existem                                                                                        | Dependem de notarização (Homebrew) ou de manifestos próprios        |

## Por que não no Homebrew oficial

Desde setembro de 2026 o Homebrew desativa casks que falham na checagem do Gatekeeper
([anúncio do 5.0](https://brew.sh/2025/11/12/homebrew-5.0.0/)). O app sem notarização não entra.
O tap próprio traz o mesmo cask com um `postflight` que tira a quarentena. Com a conta paga da Apple
(US$ 99 por ano), a notarização no CI libera o cask oficial e o auto-update nativo no Mac.

## Como atualizar cada canal a cada release

O `build/empacotar.mjs` lê o `SHA256SUMS.txt` da release e gera os três manifestos:

```bash
node build/empacotar.mjs v0.1.6 saida
# saida/winget/manifests/f/FaKLCode/FaKLCode/0.1.6/*.yaml
# saida/scoop/bucket/fakl-code.json
# saida/homebrew/Casks/fakl-code.rb
winget validate --manifest saida/winget/manifests/f/FaKLCode/FaKLCode/0.1.6
```

Automático: o job `empacotar` do `release.yml` publica o Scoop e o Homebrew sozinho depois de cada
release, com uma chave de deploy por repositório (secrets `EMPACOTAMENTO_CHAVE_SCOOP` e
`EMPACOTAMENTO_CHAVE_TAP`; cada chave só escreve no repositório dela, ao contrário de um token da
conta). Sem os secrets, o job é pulado. Para recriar as chaves: `ssh-keygen -t ed25519`, adicionar a
pública como chave de deploy com escrita em `FaKL-Code/scoop-bucket` e em `FaKL-Code/homebrew-tap`
(`gh repo deploy-key add`) e guardar as privadas com `gh secret set`. O winget segue por PR ao
`microsoft/winget-pkgs`, que essas chaves não alcançam; depois do primeiro pacote aceito, a ação
[winget-releaser](https://github.com/vedantmgoyal9/winget-releaser) (com um token que possa abrir PR
no winget-pkgs) pode abrir os PRs seguintes.

## Linux (experimental)

A release traz `.tar.gz`, `.deb` e `.rpm` para x64, compilados no Ubuntu 22.04 (glibc 2.35: não abrem
em distribuições mais antigas). O CI valida a compilação, o `.deb` e a abertura sob Xvfb; ninguém
instalou o pacote numa distribuição de verdade ainda. No Linux a IDE só avisa de versão nova e abre
o download. Não há AppImage, Snap, Flatpak nem AUR: o VSCodium publica todos, mas o Flathub exige
build a partir do código sem rede e **proíbe manifestos gerados ou assistidos por IA**, então o
Flatpak teria de ser escrito à mão. Veja o [roadmap](../ROADMAP.md).
