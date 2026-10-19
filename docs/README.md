# Documentação

- [SDD](sdd.md): requisitos, arquitetura, contratos e marcos. É a especificação
  que pessoas e agentes seguem para implementar a IDE.
- [Múltiplos projetos](especificacao-multiplos-projetos.md): proposta futura
  para manter projetos isolados na mesma GUI, cada um com sua Mesa, Café,
  maestro e agentes.
- [Segurança de recursos](seguranca-de-recursos.md): o que a varredura estática
  de skills, agentes e MCPs faz e não faz antes de instalar.
- [Placar dos agentes](placar-de-agentes.md): o que é medido por perfil (aprovação, duração,
  custo, limites), o que não é e como zerar.
- [Build da IDE](build.md): como a IDE é compilada com a marca FaKL-Code.
- [Distribuição](distribuicao.md): winget, Scoop, Homebrew e Linux, e como cada canal é mantido.
- [Roadmap](../ROADMAP.md): lacunas e evolução da IDE.
- [Termos dos provedores](termos-dos-provedores.md): regras de Anthropic, OpenAI e Google para clientes
  de terceiros e o que a IDE faz a respeito.
- [Acessibilidade](acessibilidade.md): o que funciona por teclado e leitor de tela no grafo do vault,
  no café e no app do celular, os atalhos e o que ainda falta.
- [Privacidade](privacidade.md): o que a IDE consulta na rede e como desligar.
- [Marca](marca/): logo, paleta e peças da identidade Terminal.
- [Site](../apps/landing/README.md): landing page, documentação pública e download.
- [Modo minimizado](ux/modo-minimizado.md): o pet e o painel dos agentes por
  cima de tudo, o que cada um faz e o contrato com o processo principal.
- [UX do chat com agentes](ux/chat-agentes.md): hierarquia visual, estados,
  responsividade e critérios de aceite do chat lateral.
- [ADRs](adr/): decisões de arquitetura, uma por arquivo, numeradas. Para uma
  decisão nova, copie [`adr/0000-modelo.md`](adr/0000-modelo.md).

| ADR                                                                            | Decisão                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| [0001](adr/0001-fork-do-vscodium.md)                                           | Fork do VSCodium em vez de extensão                                     |
| [0002](adr/0002-monorepo-pnpm-typescript.md)                                   | Monorepo com pnpm e TypeScript estrito                                  |
| [0003](adr/0003-fluxo-git-e-versionamento.md)                                  | Fluxo de git, commits e versionamento                                   |
| [0004](adr/0004-sync-de-configuracoes-por-git.md)                              | Sincronização de configurações por git                                  |
| [0005](adr/0005-core-iniciado-pela-ide.md)                                     | Core iniciado pelo processo principal da IDE                            |
| [0006](adr/0006-notificacoes-e-fechamento-pelo-processo-principal.md)          | Notificações e fechamento pelo processo principal                       |
| [0007](adr/0007-store-em-arquivos.md)                                          | Armazenamento do Core em arquivos JSON                                  |
| [0008](adr/0008-vault-no-core-com-indice-em-memoria.md)                        | Vault no Core com índice em memória                                     |
| [0009](adr/0009-controle-remoto-por-relay-com-cifra-de-ponta-a-ponta.md)       | Controle remoto por relay com cifra de ponta a ponta                    |
| [0010](adr/0010-integracoes-com-cofre-em-memoria-e-aprovacoes-no-core.md)      | Integrações com cofre em memória e aprovações no Core                   |
| [0011](adr/0011-cyber-cafe-em-canvas-2d.md)                                    | Cyber café em Canvas 2D com arte desenhada em código                    |
| [0012](adr/0012-adaptador-local-com-laco-de-ferramentas-proprio.md)            | Adaptador local com laço de ferramentas próprio                         |
| [0013](adr/0013-busca-semantica-com-embeddings-locais.md)                      | Busca semântica com embeddings locais                                   |
| [0014](adr/0014-ingles-da-interface-adiado.md)                                 | Inglês da interface adiado (substituída pela 0036)                      |
| [0015](adr/0015-marca-terminal.md)                                             | Marca Terminal                                                          |
| [0016](adr/0016-autopilot-e-modos-de-permissao.md)                             | Autopilot e modos de permissão                                          |
| [0017](adr/0017-mesa-canvas-dos-agentes.md)                                    | Mesa: o canvas dos agentes como tela principal                          |
| [0018](adr/0018-pasta-remota-ssh-nativa.md)                                    | Pasta remota por SSH nativa, sem extensão                               |
| [0019](adr/0019-ssh-na-mesma-janela-e-para-agentes.md)                         | SSH na mesma janela, como raiz do workspace, e disponível aos agentes   |
| [0020](adr/0020-github-da-conta-inteira.md)                                    | GitHub da conta inteira, não do repositório aberto                      |
| [0021](adr/0021-contas-claude-em-paralelo.md)                                  | Até três contas do Claude logadas ao mesmo tempo                        |
| [0022](adr/0022-agentes-persistentes.md)                                       | Agentes que sobrevivem a reinícios e atualizações                       |
| [0023](adr/0023-app-remoto-com-conversa-no-core.md)                            | App remoto refeito, com a conversa montada no Core                      |
| [0024](adr/0024-email-imap-integrado.md)                                       | Email IMAP nativo na IDE e leitura por agentes                          |
| [0025](adr/0025-orquestracao-no-chat.md)                                       | Orquestração no chat: todo agente chama outros agentes                  |
| [0026](adr/0026-janelas-de-uso-dos-planos.md)                                  | Sessão de 5 horas e limite semanal lidos dos registros dos CLIs         |
| [0027](adr/0027-troca-de-conta-claude.md)                                      | Troca de conta do Claude com um clique, nos agentes abertos             |
| [0028](adr/0028-troca-de-conta-claude-pelo-celular.md)                         | Troca de conta do Claude pelo celular                                   |
| [0029](adr/0029-memoria-do-projeto-ligada-no-vault.md)                         | Memória do projeto ligada no vault                                      |
| [0030](adr/0030-github-em-tela-cheia-renderizado-pela-api.md)                  | GitHub em tela cheia renderizado pela API                               |
| [0031](adr/0031-comandos-por-voz.md)                                           | Comandos por voz                                                        |
| [0032](adr/0032-modo-minimizado.md)                                            | Modo minimizado: overlay dos agentes                                    |
| [0033](adr/0033-retomada-de-tarefas-apos-limite-de-sessao.md)                  | Retomada de tarefas após limite de sessão                               |
| [0034](adr/0034-multi-monitor-com-janelas-auxiliares.md)                       | Multi-monitor com as janelas auxiliares do VS Code                      |
| [0035](adr/0035-provedores-de-ia-detectados.md)                                | Provedores de IA detectados, não presumidos                             |
| [0035](adr/0035-site-da-ide-em-astro.md)                                       | Site da IDE em Astro, com as telas reais                                |
| [0036](adr/0036-idioma-do-sistema-com-pacote-pt-br-embutido.md)                | Idioma do sistema, com o pacote pt-BR embutido                          |
| [0037](adr/0037-atualizacao-automatica-pelos-github-releases.md)               | Atualização automática pelos GitHub Releases                            |
| [0038](adr/0038-adaptadores-acp-em-dia-e-codex-path.md)                        | Adaptadores ACP em dia e o CODEX_PATH                                   |
| [0039](adr/0039-conversas-das-extensoes-do-codex-e-do-claude-code.md)          | Conversas das extensões do Codex e do Claude Code                       |
| [0040](adr/0040-doctor-e-tour-guiado.md)                                       | Doctor e tour guiado                                                    |
| [0041](adr/0041-chave-de-api-do-codex-em-pasta-propria.md)                     | Chave de API do Codex em pasta própria                                  |
| [0042](adr/0042-varredura-estatica-de-recursos.md)                             | Varredura estática de skills, agentes e MCPs                            |
| [0043](adr/0043-placar-de-agentes.md)                                          | Placar de agentes por perfil                                            |
| [0044](adr/0044-identidade-do-controle-remoto-cifrada-em-repouso.md)           | Identidade do controle remoto cifrada em repouso                        |
| [0045](adr/0045-inventario-de-rede-e-interruptor-das-consultas-automaticas.md) | Inventário de rede e interruptor das consultas automáticas              |
| [0046](adr/0046-terminal-ao-vivo-somente-leitura-por-agente.md)                | Terminal ao vivo, somente leitura, por agente                           |
| [0047](adr/0047-agente-de-terminal-sobre-o-terminal-do-vscode.md)              | Agente de terminal interativo sobre o terminal do VS Code               |
| [0050](adr/0050-busca-semantica-por-api-de-embeddings.md)                      | Busca semântica por API de embeddings compatível com a da OpenAI        |
| [0051](adr/0051-cafe-do-ci.md)                                                 | Café do CI: as execuções do GitHub Actions como a cozinha do cyber café |
| [0052](adr/0052-modo-economico-de-tokens.md)                                   | Modo econômico de tokens                                                |
