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
| Homebrew oficial, Chocolatey, Flathub, Snap, AUR | vários      | Não existem                                                                                        | Dependem de notarização (Homebrew) ou de build para Linux           |

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

Automático: se o repositório definir o secret `EMPACOTAMENTO_TOKEN` (um token fine-grained com
escrita de conteúdo em `FaKL-Code/scoop-bucket` e `FaKL-Code/homebrew-tap`), o job `empacotar` do
`release.yml` publica o Scoop e o Homebrew sozinho depois de cada release. Sem o secret, o job é
pulado. O winget segue por PR ao `microsoft/winget-pkgs`, que o token acima não alcança; depois do
primeiro pacote aceito, a ação [winget-releaser](https://github.com/vedantmgoyal9/winget-releaser)
(com um token que possa abrir PR no winget-pkgs) pode abrir os PRs seguintes.

## Linux

Ainda não há build para Linux. O VSCodium publica `.deb`, `.rpm`, AppImage e Snap, e o Flathub exige
build a partir do código sem rede e **proíbe manifestos gerados ou assistidos por IA**, então o
Flatpak teria de ser escrito à mão. Veja o [roadmap](../ROADMAP.md).
