# 0003. Fluxo de git, commits e versionamento

- Status: aceita
- Data: 2026-10-11

## Contexto

O repositório vai receber trabalho de pessoas e de agentes ao mesmo tempo. O
histórico precisa ser legível, rastreável até os requisitos do SDD e gerar
changelog e versões sem trabalho manual.

## Decisão

- **Trunk-based**: `main` é sempre estável e protegida; todo trabalho entra por
  PR a partir de um branch curto (`feat/...`, `fix/...`, `docs/...`; agentes da
  IDE usam `fakl/...`, conforme o SDD 14.3).
- **Conventional Commits** com os escopos definidos em `commitlint.config.mjs`,
  verificados por gancho local (lefthook) e pelo título do PR no CI.
- **Squash merge**: um PR vira um commit na `main`, com o título do PR como
  mensagem.
- **SemVer próprio** para a FaKL-Code (começando em 0.x durante os marcos), com
  a versão do VS Code de base registrada em `upstream/stable.json` e mostrada
  em Ajuda > Sobre. Releases são tags `v*`, criadas pelo `release.yml` quando o
  dono pede, e geram o changelog a partir dos commits. O número interno do binário segue o esquema do VSCodium (versão do
  VS Code mais um contador, por exemplo `1.135.06055`), que as ferramentas de
  build exigem; a versão da FaKL-Code é a da tag e da release.
- **Releases públicas**: os instaladores ficam nas GitHub Releases deste
  repositório. Sem atualização automática por enquanto.
- **Revisão obrigatória** pelos mantenedores (CODEOWNERS) e CI verde antes do merge.

## Consequências

- O changelog e o número da próxima versão saem dos tipos de commit
  (`feat` sobe minor, `fix` sobe patch, `!` sobe major depois do 1.0).
- PRs de agentes seguem as mesmas regras que PRs humanos.

## Alternativas consideradas

- Git Flow com `develop`: mais cerimônia sem ganho para um projeto de um dono.
- Versionar igual ao VS Code (1.135.x): confunde atualizações nossas com as do
  upstream.
