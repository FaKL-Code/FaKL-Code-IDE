# Assinatura dos instaladores

## Windows: SignPath

Os `.exe` são assinados no [SignPath Foundation](https://signpath.org/) (gratuito para
projetos open source). Para ligar:

1. Peça a adesão do repositório público ao programa e crie o projeto, a política de
   assinatura e a configuração do artefato (assina os `.exe` na raiz do ZIP).
2. No repositório, em Settings → Secrets and variables → Actions:
   - Secret `SIGNPATH_API_TOKEN`: token de API do usuário CI do SignPath.
   - Variáveis `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` e `SIGNPATH_POLICY_SLUG`.
3. Rode a release. Sem `SIGNPATH_ORGANIZATION_ID`, o job `assinar-windows` é pulado e o
   Windows sai sem assinatura (o SmartScreen avisa na primeira execução).

## macOS: sem assinatura da Apple

O app do macOS é assinado só de forma ad hoc, sem notarização (isso exige uma conta
paga no Apple Developer Program). Por isso o Gatekeeper bloqueia a primeira abertura:
veja "Instalação" no [README](../README.md#instalação).
