# FaKL-Code: configurações

Extensão embutida da FaKL-Code IDE.

- **Importar do VS Code** (RF-004): na primeira abertura, oferece trazer settings,
  atalhos, snippets e extensões do VS Code, VS Code Insiders ou VSCodium. As
  extensões vêm do Open VSX; as que não existem lá são listadas no fim.
- **Sincronizar entre máquinas** (RF-005): guarda settings, atalhos, snippets,
  lista de extensões, `~/.fakl/config.yaml` e os perfis de agente num
  repositório **privado** do GitHub. Sincroniza ao abrir, a cada 5 minutos e
  logo depois de mudar uma configuração. Settings em `fakl.sync.ignoredSettings`
  ficam só na máquina.

Comandos: `FaKL: Importar configurações do VS Code`, `FaKL: Configurar
sincronização entre máquinas`, `FaKL: Sincronizar configurações agora`.

O token do GitHub vem do login da IDE e é passado ao git por variável de
ambiente, sem ser gravado em disco.
