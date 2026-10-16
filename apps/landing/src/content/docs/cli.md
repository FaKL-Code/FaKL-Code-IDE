---
titulo: CLI fakl
descricao: Controlar o Core pela linha de comando.
ordem: 13
---

Depois de **Pôr a CLI fakl no PATH do sistema**, o comando `fakl` fala com o Core da IDE aberta. Os terminais da própria IDE já o têm.

```sh
fakl status                       # estado do Core
fakl agentes                      # sessões de agente
fakl maestro "corrigir o checkout" --repo . --criterio "pnpm test" --aguardar
fakl tarefas                      # lista as tarefas
fakl decisoes                     # decisões e pedidos de permissão pendentes
fakl permitir <sessão> <pedido>   # aprova um pedido
fakl modo <sessão> aprovar-leitura
fakl custos                       # gasto do dia por provedor
fakl contas                       # contas do Claude
fakl conta usar 2
fakl ssh producao-web uptime
```

`--json` em qualquer comando imprime a resposta crua. `fakl --help` lista tudo.
