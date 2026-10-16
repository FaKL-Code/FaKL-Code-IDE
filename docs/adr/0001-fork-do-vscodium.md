# 0001. Fork do VSCodium em vez de extensão

- Status: aceita
- Data: 2026-10-11
- Requisitos: RF-001, RF-002, RF-003, RNF-10, RNF-11

## Contexto

A FaKL-Code precisa de marca própria, layout padrão próprio, ciclo de vida
ligado ao FaKL Core e atualização a partir dos nossos GitHub Releases. Nada disso
é possível como extensão. O VS Code oficial também não pode ser redistribuído
com outra marca, e o marketplace da Microsoft não pode ser usado por forks.

## Decisão

Construir a IDE a partir do Code-OSS usando os scripts de build do VSCodium,
com a versão fixada em `upstream/stable.json`. Alterações no código do VS Code
ficam restritas às cinco áreas da seção 5.3 do SDD, como patches em `patches/`.
Todo o resto é extensão embutida (`extensions/`) ou FaKL Core (`packages/core`).

## Consequências

- Recebemos de graça o trabalho do VSCodium para remover telemetria e marca da
  Microsoft e para gerar binários nas três arquiteturas.
- Cada atualização do VS Code exige reaplicar patches; manter poucos patches,
  pequenos e por área, é o que mantém isso barato (RNF-10).
- Extensões vêm do Open VSX; algumas extensões proprietárias da Microsoft
  (Remote SSH, Pylance, Live Share) não estarão disponíveis, e as integrações
  equivalentes são nossas (M5).

## Alternativas consideradas

- Extensão sobre o VS Code oficial: sem marca, sem controle do ciclo de vida.
- Fork de outro editor baseado em VS Code (Cursor, Windsurf, Theia): código
  fechado ou base menos compatível com extensões.
