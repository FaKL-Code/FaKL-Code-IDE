# Como contribuir

Vale para pessoas e para agentes. A especificação está em [`docs/sdd.md`](docs/sdd.md)
e as decisões de arquitetura em [`docs/adr/`](docs/adr/).

## Ambiente

- Node na versão de `.nvmrc` (24) e pnpm via Corepack: `corepack enable`.
- `pnpm install` instala dependências e os ganchos de git (lefthook).
- `pnpm check` roda tudo o que o CI roda: formato, lint, tipos e testes.

| Comando          | O que faz                               |
| ---------------- | --------------------------------------- |
| `pnpm build`     | Compila todos os pacotes                |
| `pnpm test`      | Testes unitários (Vitest)               |
| `pnpm lint`      | ESLint com regras de tipo, sem warnings |
| `pnpm typecheck` | TypeScript estrito em todos os pacotes  |
| `pnpm format`    | Formata com Prettier                    |

## Fluxo de trabalho

1. Crie um branch curto a partir da `main`: `feat/<assunto>`, `fix/<assunto>`,
   `docs/<assunto>`. Agentes da IDE usam `fakl/<assunto>`.
2. Faça commits no formato [Conventional Commits](https://www.conventionalcommits.org/pt-br/):
   `tipo(escopo): assunto em minúsculas`. Os escopos válidos estão em
   [`commitlint.config.mjs`](commitlint.config.mjs) e espelham as pastas do repositório.
3. Abra um PR preenchendo o modelo, com os IDs do SDD que ele atende. O título
   do PR segue o mesmo formato, porque vira o commit na `main` (squash merge).
4. Assine o [CLA](CLA.md) comentando no PR a frase que o bot pedir (uma vez só).
5. O PR entra com CI verde, CLA assinado e revisão aprovada.

Exemplos de commit:

```text
feat(protocol): adiciona tópicos de eventos do Core
fix(core): encerra agentes órfãos ao fechar a IDE
build(upstream): atualiza code-oss para 1.136.0
docs(adr): registra decisão sobre o relay
```

## Onde cada coisa mora

```text
upstream/     versão fixada do Code-OSS
patches/      patches no core do VS Code, um por área (SDD 5.3)
branding/     ícones, temas, product.json
extensions/   extensões embutidas fakl-*
packages/     Core, protocolo, adaptadores, servidor MCP, CLI, ui-kit
apps/         cliente remoto (PWA) e relay
docs/         SDD e ADRs
```

Features novas vivem em extensões embutidas ou no Core, nunca espalhadas pelo
código do VS Code (RNF-11). Um patch novo no core precisa de uma ADR.

## Testes

Todo comportamento novo vem com teste. Unidade e contrato com Vitest, ao lado do
pacote em `test/`. Testes que dependem de provedores reais de IA não rodam no CI
padrão (SDD 15.3).

## Segredos

Nunca commite tokens, chaves ou `.env`. Veja [`SECURITY.md`](SECURITY.md).
