# 0007. Armazenamento do Core em arquivos JSON, não SQLite

- Status: aceita
- Data: 2026-10-12
- Requisitos: RNF-13; SDD 6.2 (`store`), 6.5, 7

## Contexto

O SDD previa um banco SQLite em `~/.fakl/fakl.db` para tarefas, execuções,
eventos, custos e auditoria. O Core roda num `utilityProcess` do Electron,
empacotado com esbuild num único `core.mjs`. Um módulo nativo
(`better-sqlite3`) teria de ser recompilado para a versão de Node do Electron
em cada plataforma e entraria no build da IDE; o `node:sqlite` embutido ainda
é experimental e não há garantia de que o Electron o exponha. Os volumes
esperados são pequenos: algumas dezenas de tarefas e alguns milhares de
lançamentos de custo por mês.

## Decisão

- O módulo `store` grava em `~/.fakl/data` (não sincroniza entre máquinas):
  - registros só de inserção em JSON Lines (`costs.jsonl`, `runs.jsonl`,
    `audit.jsonl`), lidos inteiros ao iniciar;
  - documentos com o estado atual (`tasks/<id>.json`), gravados num arquivo
    temporário e renomeados, para nunca ficarem pela metade.
- Uma linha cortada por queda no meio da gravação é ignorada na leitura.
- Arquivos criados com permissão só do usuário.

## Consequências

- Nenhuma dependência nativa; o Core continua um único arquivo JavaScript.
- Consultas são feitas em memória. Se os volumes crescerem a ponto de pesar,
  a troca por SQLite fica contida no módulo `store`, sem mudar a API local.
- O SDD passa a citar `~/.fakl/data/` no lugar de `~/.fakl/fakl.db`.
