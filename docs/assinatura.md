# Assinatura dos instaladores

## Windows: sem assinatura

O instalador do Windows não é assinado. O pedido de adesão ao
[SignPath Foundation](https://signpath.org/), programa de assinatura gratuito para
projetos open source, foi recusado. Por isso o SmartScreen mostra "O Windows protegeu o
computador" na primeira execução: clique em **Mais informações** e em **Executar assim
mesmo**.

Para conferir que o arquivo é o da release, compare o hash com o `SHA256SUMS.txt` da
mesma página. No PowerShell:

```powershell
Get-FileHash .\FaKL-Code-Windows-x64.exe -Algorithm SHA256
```

A atualização automática não depende da assinatura: ela confere o SHA-256 do
instalador que o manifesto da release informa (ADR 0037).

### Se a assinatura voltar

O `release.yml` mantém o job `assinar-windows`, que só roda quando o repositório define
a variável `SIGNPATH_ORGANIZATION_ID`; sem ela é pulado e o Windows sai sem assinatura,
como hoje. Se um novo pedido ao SignPath for aprovado:

1. Crie o projeto, a política de assinatura e a configuração do artefato (assina os
   `.exe` na raiz do ZIP).
2. No repositório, em Settings → Secrets and variables → Actions:
   - Secret `SIGNPATH_API_TOKEN`: token de API do usuário CI do SignPath.
   - Variáveis `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` e `SIGNPATH_POLICY_SLUG`.
3. Rode a release. Os `.exe` assinados substituem os de mesmo nome antes de publicar, e
   os manifestos de atualização já saem com o hash do arquivo assinado.

Outro serviço de assinatura exige trocar o passo do SignPath por um equivalente, mas o
resto do fluxo (substituir os `.exe` e gerar os manifestos depois) continua igual.

## macOS: assinatura e notarização da Apple

Com a conta paga do Apple Developer Program, o build do macOS assina o app com um
certificado Developer ID Application, notariza na Apple e carimba o resultado
(`stapler`), e a release passa a trazer também um `.dmg`. Quem faz isso é o
`prepare_assets.sh` do VSCodium; o `build.yml` só entrega os segredos ao job do
macOS e o `build/build.sh` confere o resultado (`codesign`, `stapler validate` e
`spctl`) antes de empacotar, para uma release nunca sair com um app que o Gatekeeper
recusa.

Sem os segredos o app sai assinado só de forma ad hoc, sem notarização, e o Gatekeeper
bloqueia a primeira abertura (veja "Instalação" no [README](../README.md#instalação)).

### Como ativar

1. No [portal de desenvolvedor da Apple](https://developer.apple.com/account), em
   Certificates, crie um certificado **Developer ID Application**, instale-o no Mac e
   exporte do Acesso às Chaves (certificado e chave privada) como `.p12`, com senha.
2. Em [account.apple.com](https://account.apple.com), em Segurança, gere uma **senha
   específica de app** para a notarização.
3. Anote o **Team ID** (portal de desenvolvedor, Membership details).
4. No repositório, em Settings → Secrets and variables → Actions, crie os segredos:

| Segredo                      | Valor                                     |
| ---------------------------- | ----------------------------------------- |
| `APPLE_CERTIFICATE_P12`      | o `.p12` em base64 (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | a senha do `.p12`                         |
| `APPLE_ID`                   | o e-mail do Apple ID da conta             |
| `APPLE_TEAM_ID`              | o Team ID de 10 caracteres                |
| `APPLE_APP_PASSWORD`         | a senha específica de app da notarização  |

5. Rode a release (ou só o build do macOS). O log mostra "Conferindo a assinatura e a
   notarização"; a release publica `FaKL-Code-macOS-arm64.zip` e `FaKL-Code-macOS-arm64.dmg`.
6. Na primeira release assinada, tire o aviso do Gatekeeper do README e atualize o
   texto de [distribuição](distribuicao.md).

Os cinco segredos são opcionais: se faltar qualquer um depois de definir o `.p12`, a
notarização falha e o build para, em vez de publicar algo meio assinado.
