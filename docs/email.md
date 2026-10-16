# Email na IDE

A view **Email → Caixa de entrada** conecta uma ou mais caixas por IMAP com TLS. Use o endereço do servidor, a porta TLS (normalmente 993), o usuário e uma senha de aplicativo quando o provedor exigir. A conexão é validada ao adicionar a conta.

No Gmail, habilite IMAP e use uma senha de app se a conta permitir. Em contas Microsoft ou corporativas, o administrador pode precisar habilitar IMAP com autenticação por senha; caixas que exigem OAuth ainda não são suportadas nesta versão. Servidores sem TLS também não são aceitos.

As senhas ficam no `SecretStorage` da IDE (Keychain/DPAPI). O Core as mantém apenas em memória enquanto a IDE está aberta. A extensão guarda somente endereço e parâmetros de conexão em `globalState`. Remover uma conta apaga a senha guardada.

Os agentes recebem as ferramentas MCP `email_accounts`, `email_inbox` e `email_read` quando há pelo menos uma conta conectada. São operações de leitura da pasta INBOX; não há envio, exclusão, alteração de estado ou acesso a anexos. Remetente, assunto, prévia e corpo são identificados como conteúdo externo não confiável.
