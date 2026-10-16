# 0004. Sincronização de configurações por git

- Status: aceita
- Data: 2026-10-11
- Requisitos: RF-004, RF-005, RNF-07, RNF-09

## Contexto

O VSCodium não tem o Settings Sync da Microsoft. A FaKL-Code precisa levar
settings, atalhos, snippets, extensões e perfis de agente entre as duas
máquinas do usuário, sem servidor próprio e sem serviço rodando com a IDE
fechada.

## Decisão

- A extensão embutida `fakl-settings` guarda o estado num repositório
  **privado** do GitHub do usuário, clonado em `~/.fakl/sync/repo`. A lógica
  fica no pacote `@fakl/settings-sync`, testado com git real.
- Cada sincronização exporta o estado local para o clone, faz commit, rebase
  sobre o remoto e push, e depois aplica o resultado de volta nesta máquina. O
  git faz a mesclagem de três vias; mudanças em linhas diferentes das duas
  máquinas se somam.
- Em conflito na mesma linha, vale a máquina que sincroniza por último
  (`rebase -X theirs`).
- Na primeira sincronização de uma máquina num repositório que já tem dados, as
  configurações locais são somadas às do repositório, sem sobrescrever.
- Settings listados em `fakl.sync.ignoredSettings` ficam só na máquina.
- O token do GitHub vem do login da IDE e chega ao git por `GIT_CONFIG_*` no
  ambiente do processo: não vai para a linha de comando nem para o disco.
- Extensões são instaladas do Open VSX quando aparecem na lista sincronizada;
  nunca são desinstaladas automaticamente.

## Consequências

- Histórico completo das configurações no GitHub, com possibilidade de voltar
  versões.
- Desinstalar uma extensão numa máquina não a remove da outra, e ela pode
  voltar para a lista na sincronização seguinte. Remoção sincronizada fica para
  depois.
- Um repositório público é aceito só depois de um aviso explícito.

## Alternativas consideradas

- Gist do GitHub (como a extensão Settings Sync antiga): sem mesclagem de três
  vias e com limites de tamanho.
- Servidor próprio: contraria a decisão de não manter serviços além do relay.
