---
titulo: 'fakl CLI'
descricao: 'Control the Core from the command line.'
ordem: 13
---

After **Add the fakl CLI to the system PATH**, the `fakl` command talks to the Core of the running IDE. The IDE's own terminals already have it.

```sh
fakl status                       # Core state
fakl agentes                      # agent sessions
fakl maestro "corrigir o checkout" --repo . --criterio "pnpm test" --aguardar
fakl tarefas                      # lists the tasks
fakl decisoes                     # pending decisions and permission requests
fakl permitir <sessão> <pedido>   # approves a request
fakl modo <sessão> aprovar-leitura
fakl custos                       # the day's spending by provider
fakl contas                       # Claude accounts
fakl conta usar 2
fakl ssh producao-web uptime
```

`--json` on any command prints the raw response. `fakl --help` lists everything.
