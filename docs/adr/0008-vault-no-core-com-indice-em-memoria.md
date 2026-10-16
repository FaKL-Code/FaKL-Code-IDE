# 0008. Vault no Core, com índice em memória e tokens por sessão

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-401 a RF-406, RF-208, RF-210; SDD 10

## Contexto

O SDD previa o índice do vault no SQLite (FTS5). A ADR 0007 tirou o SQLite do
Core. Os agentes precisam das ferramentas do vault (SDD 10.4) com as mesmas
regras que a IDE aplica, e o maestro já recebia um servidor MCP `fakl` com um
token só dele.

## Decisão

- O vault vive no Core (`VaultService`), configurado em `vault:` no
  `config.yaml` (`caminho`, `remoto`, `sincronizar`). Sem essa chave, fica
  desligado. Mudar a chave reabre o vault sem reiniciar a IDE.
- Índice em memória: a leitura inteira na abertura, depois um observador de
  arquivos com espera de 200 ms. A busca aceita palavras sem acento, `tag:` ou
  `#tag` e `pasta:`. Links resolvem como no Obsidian: caminho exato, depois
  nome da nota sem diferenciar maiúsculas, preferindo o caminho mais curto.
- Sincronização por git como no SDD 10.2. No rebase, um conflito mantém a
  versão remota e grava a local como `<nota> (conflito <máquina>).md`. Num
  clone ainda vazio, a máquina nova só pega o que já está no remoto.
- Um único servidor MCP `fakl` serve conjuntos de ferramentas (`maestro`,
  `vault`). O Core emite, por sessão, um token que só abre os métodos dos
  conjuntos entregues, e o revoga quando a sessão termina. Todo agente ganha
  o conjunto `vault` quando há vault aberto; o maestro ganha os dois.
- Chamadas com token de agente não veem notas `privado: true` e só escrevem em
  `Agentes/` e `Projetos/`. Em vez de pedir confirmação para outras pastas, o
  Core recusa e diz ao agente para pedir ao usuário.
- O Core grava uma nota por execução terminada em `Agentes/Sessões/` e cria
  tarefas a partir de playbooks (`Playbooks/`, `tipo: playbook`) e de notas.

## Consequências

- Nenhuma dependência nova; buscas em alguns milhares de notas ficam abaixo de
  dezenas de milissegundos.
- A busca semântica (RF-407) e o Git LFS para anexos grandes ficam para depois;
  quando vierem, o índice pode ganhar um arquivo próprio em `~/.fakl/data`.
- As regras dos agentes ficam num só lugar, valendo para MCP, CLI e remoto.
