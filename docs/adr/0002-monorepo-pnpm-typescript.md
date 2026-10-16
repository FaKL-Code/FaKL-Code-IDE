# 0002. Monorepo com pnpm workspaces e TypeScript estrito

- Status: aceita
- Data: 2026-10-11
- Requisitos: RNF-11, RNF-12

## Contexto

Core, extensões, CLI, cliente remoto e relay compartilham tipos (protocolo
JSON-RPC, eventos, perfis). Repositórios separados obrigariam a publicar e
versionar pacotes internos só para manter os tipos em dia.

## Decisão

Um único repositório com pnpm workspaces (`packages/*`, `apps/*`,
`extensions/*`), TypeScript em modo estrito com uma configuração base comum,
ESLint com regras de tipo, Prettier para formatação e Vitest para testes. A
versão do Node fica em `.nvmrc` e a do pnpm em `packageManager`.

## Consequências

- Uma mudança no protocolo e em todos os seus consumidores cabe num único PR.
- `pnpm check` roda formato, lint, tipos e testes de tudo, localmente e no CI.
- O código do VS Code baixado no build (`vscode/`) fica fora do workspace e é
  ignorado pelo git.

## Alternativas consideradas

- npm ou Yarn workspaces: pnpm é mais rápido e mais rígido com dependências
  não declaradas.
- Nx ou Turborepo: úteis quando o número de pacotes crescer; podem entrar depois
  sem mudar a estrutura.
