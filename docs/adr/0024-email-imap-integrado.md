# 0024. Email IMAP nativo na IDE e leitura por agentes

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-510
- Complementa: [0010](0010-integracoes-com-cofre-em-memoria-e-aprovacoes-no-core.md)

## Contexto

O hub MCP já permite configurar servidores de terceiros, mas uma caixa de email é um recurso pessoal que precisa aparecer na IDE e ficar disponível aos agentes sem compartilhar credenciais com eles.

## Decisão

- A primeira versão conecta caixas por IMAP com TLS e senha de aplicativo, mostra a INBOX numa view nativa e abre mensagens como documentos Markdown.
- A extensão mantém os metadados da conta em `globalState` e guarda a senha no `SecretStorage`. Envia credenciais ao Core somente ao conectar ou reconectar; o Core as mantém em memória.
- O Core expõe `email_accounts`, `email_inbox` e `email_read` como ferramentas MCP somente de leitura. Elas só entram nos tokens de sessão quando há conta configurada.
- O agente nunca recebe a senha. Assunto, remetente, prévia e corpo retornados às ferramentas são marcados como conteúdo externo não confiável.
- Envio, alteração de estado, exclusão, anexos, autenticação OAuth e servidores sem TLS ficam fora desta versão.

## Consequências

- Gmail e servidores IMAP que aceitam senha de aplicativo podem ser conectados sem instalar um MCP externo. A política do provedor pode exigir habilitação de IMAP ou impedir autenticação por senha.
- A IDE e os agentes compartilham a mesma caixa configurada, mas as credenciais continuam sob controle do cofre do sistema operacional.
- Caixas que só aceitam OAuth, incluindo algumas contas Microsoft corporativas, precisam de uma etapa futura de autenticação OAuth.
