# 0018. Pasta remota por SSH nativa, sem extensão

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-504
- Substitui, em parte: SDD 13 (workspace remoto pelo open-remote-ssh)
- Substituída em parte pela [ADR 0019](0019-ssh-na-mesma-janela-e-para-agentes.md):
  "janela nova", "terminal ao abrir" e "agentes na pasta padrão"

## Contexto

"Abrir pasta remota" dependia da extensão open-remote-ssh, que a IDE oferecia
instalar. Instalar uma extensão para isso não era desejável, e pediu-se SSH nativo.

Embutir a extensão não resolve sozinho. Ela baixa no servidor um "servidor
remoto" da IDE compilado para o mesmo commit. Para a FaKL-Code esse servidor
teria de ser compilado para Linux e hospedado num endereço público. O build de
Linux precisa de um runner Linux, e os runners do GitHub estão bloqueados por
cobrança neste repositório.

## Decisão

A extensão FaKL registra o sistema de arquivos `fakl-ssh://<alias>/<caminho>`.

- Cada host ganha um `sh` de vida longa aberto pelo `ssh` do sistema, com
  `BatchMode=yes`. Valem o `~/.ssh/config`, as chaves e o ssh-agent, como no
  `ssh_exec` do Core (ADR 0010).
- Os pedidos rodam um de cada vez. Cada um termina com um marcador que traz o
  código de saída.
- Ler e gravar passam por `base64`. Listar usa um laço de `sh` POSIX, e `stat`
  usa `stat -c`. Não se instala nada no servidor.
- "Abrir pasta remota" resolve o `~` no servidor, confere que é uma pasta e
  abre uma janela nova nela (superado pela ADR 0019: agora entra no workspace da janela atual).
- A janela abre um terminal SSH já na pasta (superado pela ADR 0019: terminal sob demanda).
- Agentes iniciados numa janela remota trabalham na pasta padrão deste PC (superado pela ADR 0019: eles recebem as pastas remotas e usam `ssh_*`).

## Consequências

- Funciona com qualquer servidor Linux que tenha `sh`, `base64` e `stat`, e
  sem senha (chave SSH).
- Não há aviso de mudança vindo do servidor. O explorador relê ao atualizar (a ADR 0019 acrescentou consulta periódica).
- As extensões de linguagem rodam no PC, sobre os arquivos remotos.
- A busca em arquivos e o Ctrl+P de uma pasta remota precisam de provedores de
  busca, que no VS Code são API proposta. Ficam para um passo seguinte.
