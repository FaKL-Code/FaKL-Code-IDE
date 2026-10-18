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

## macOS: sem assinatura da Apple

O app do macOS é assinado só de forma ad hoc, sem notarização (isso exige uma conta
paga no Apple Developer Program). Por isso o Gatekeeper bloqueia a primeira abertura:
veja "Instalação" no [README](../README.md#instalação).
