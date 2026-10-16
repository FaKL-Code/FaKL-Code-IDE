---
titulo: SSH e Hostinger
descricao: Servidores SSH no workspace, políticas para agentes e a conta da Hostinger.
ordem: 8
---

## SSH

A barra **Servidores** lista os hosts do seu `~/.ssh/config`. Valem as suas chaves e o ssh-agent; nada é instalado no servidor.

- **Adicionar servidor SSH ao workspace** põe uma pasta remota ao lado das pastas locais, na mesma janela.
- **Terminal na pasta remota** abre um terminal já nela.
- **Rodar comando no host** executa um comando avulso.
- **Política dos agentes no host** define o que os agentes podem fazer em cada servidor.
- **Novo host SSH**, **Gerar chave SSH** e **Editar ~/.ssh/config** ajudam a configurar.

Agentes iniciados numa janela com pasta remota recebem essa pasta e usam ferramentas SSH. Comandos SSH de agentes sempre pedem a sua aprovação.

## Hostinger

Conecte com **Conectar à Hostinger**. Você pode:

- reiniciar e tirar snapshot de VPS;
- criar, editar e apagar registros DNS;
- gerenciar firewalls e regras, e ligar um firewall num VPS;
- abrir o hPanel.

Ações na Hostinger feitas por agentes sempre esperam você.
