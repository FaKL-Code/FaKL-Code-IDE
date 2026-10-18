# Documentação

- [SDD](sdd.md): requisitos, arquitetura, contratos e marcos. É a especificação
  que pessoas e agentes seguem para implementar a IDE.
- [Múltiplos projetos](especificacao-multiplos-projetos.md): proposta futura
  para manter projetos isolados na mesma GUI, cada um com sua Mesa, Café,
  maestro e agentes.
- [Placar dos agentes](placar-de-agentes.md): o que é medido por perfil (aprovação, duração,
  custo, limites), o que não é e como zerar.
- [Build da IDE](build.md): como a IDE é compilada com a marca FaKL-Code.
- [Distribuição](distribuicao.md): winget, Scoop, Homebrew e Linux, e como cada canal é mantido.
- [Roadmap](../ROADMAP.md): lacunas e evolução da IDE.
- [Termos dos provedores](termos-dos-provedores.md): regras de Anthropic, OpenAI e Google para clientes
  de terceiros e o que a IDE faz a respeito.
- [Marca](marca/): logo, paleta e peças da identidade Terminal.
- [Site](../apps/landing/README.md): landing page, documentação pública e download.
- [Modo minimizado](ux/modo-minimizado.md): o pet e o painel dos agentes por
  cima de tudo, o que cada um faz e o contrato com o processo principal.
- [UX do chat com agentes](ux/chat-agentes.md): hierarquia visual, estados,
  responsividade e critérios de aceite do chat lateral.
- [ADRs](adr/): decisões de arquitetura, uma por arquivo, numeradas. Para uma
  decisão nova, copie [`adr/0000-modelo.md`](adr/0000-modelo.md).

| ADR                                                                       | Decisão                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------- |
| [0001](adr/0001-fork-do-vscodium.md)                                      | Fork do VSCodium em vez de extensão                   |
| [0002](adr/0002-monorepo-pnpm-typescript.md)                              | Monorepo com pnpm e TypeScript estrito                |
| [0003](adr/0003-fluxo-git-e-versionamento.md)                             | Fluxo de git, commits e versionamento                 |
| [0004](adr/0004-sync-de-configuracoes-por-git.md)                         | Sincronização de configurações por git                |
| [0005](adr/0005-core-iniciado-pela-ide.md)                                | Core iniciado pelo processo principal da IDE          |
| [0006](adr/0006-notificacoes-e-fechamento-pelo-processo-principal.md)     | Notificações e fechamento pelo processo principal     |
| [0007](adr/0007-store-em-arquivos.md)                                     | Armazenamento do Core em arquivos JSON                |
| [0008](adr/0008-vault-no-core-com-indice-em-memoria.md)                   | Vault no Core com índice em memória                   |
| [0009](adr/0009-controle-remoto-por-relay-com-cifra-de-ponta-a-ponta.md)  | Controle remoto por relay com cifra de ponta a ponta  |
| [0010](adr/0010-integracoes-com-cofre-em-memoria-e-aprovacoes-no-core.md) | Integrações com cofre em memória e aprovações no Core |
| [0011](adr/0011-cyber-cafe-em-canvas-2d.md)                               | Cyber café em Canvas 2D com arte desenhada em código  |
| [0012](adr/0012-adaptador-local-com-laco-de-ferramentas-proprio.md)       | Adaptador local com laço de ferramentas próprio       |
| [0013](adr/0013-busca-semantica-com-embeddings-locais.md)                 | Busca semântica com embeddings locais                 |
| [0014](adr/0014-ingles-da-interface-adiado.md)                            | Inglês da interface adiado (substituída pela 0036)    |
| [0015](adr/0015-marca-terminal.md)                                        | Marca Terminal                                        |
| [0016](adr/0016-autopilot-e-modos-de-permissao.md)                        | Autopilot e modos de permissão                        |
| [0017](adr/0017-mesa-canvas-dos-agentes.md)                               | Mesa: o canvas dos agentes como tela principal        |
| [0023](adr/0023-app-remoto-com-conversa-no-core.md)                       | App remoto refeito, com a conversa montada no Core    |
| [0028](adr/0028-troca-de-conta-claude-pelo-celular.md)                    | Troca de conta do Claude pelo celular                 |
| [0029](adr/0029-memoria-do-projeto-ligada-no-vault.md)                    | Memória do projeto ligada no vault                    |
| [0031](adr/0031-comandos-por-voz.md)                                      | Comandos por voz                                      |
| [0032](adr/0032-modo-minimizado.md)                                       | Modo minimizado: overlay dos agentes                  |
| [0035](adr/0035-site-da-ide-em-astro.md)                                  | Site da IDE em Astro, com as telas reais              |
| [0036](adr/0036-idioma-do-sistema-com-pacote-pt-br-embutido.md)           | Idioma do sistema, com o pacote pt-BR embutido        |
| [0037](adr/0037-atualizacao-automatica-pelos-github-releases.md)          | Atualização automática pelos GitHub Releases          |
| [0038](adr/0038-adaptadores-acp-em-dia-e-codex-path.md)                   | Adaptadores ACP em dia e o CODEX_PATH                 |
| [0039](adr/0039-conversas-das-extensoes-do-codex-e-do-claude-code.md)     | Conversas das extensões do Codex e do Claude Code     |
| [0040](adr/0040-doctor-e-tour-guiado.md)                                  | Doctor e tour guiado                                  |
| [0041](adr/0041-chave-de-api-do-codex-em-pasta-propria.md)                | Chave de API do Codex em pasta própria                |
| [0043](adr/0043-placar-de-agentes.md)                                     | Placar de agentes por perfil                          |
| [0044](adr/0044-identidade-do-controle-remoto-cifrada-em-repouso.md)      | Identidade do controle remoto cifrada em repouso      |
