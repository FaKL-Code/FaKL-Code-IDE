# Patches no core do VS Code

Um arquivo `.patch` por área do SDD 5.3, aplicado sobre o Code-OSS depois dos
patches do VSCodium (vão para `patches/user/` dele). Use os marcadores do
VSCodium, como `!!APP_NAME!!`, em vez de escrever o nome da marca.

Todo patch novo precisa de uma ADR (RNF-10).

| Patch                          | O que faz                                                                                                                                                                                                                        | ADR        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `fakl-core-start.patch`        | Inicia o FaKL Core com a IDE (`utilityProcess`) e o encerra ao sair; notificações nativas, diálogo ao fechar com agentes e reinício do Core se ele cair                                                                          | 0005, 0006 |
| `fakl-idioma-do-sistema.patch` | Sem `locale` no `argv.json`, usa o pacote de idioma embutido do idioma do sistema (pt-BR para qualquer português) e o registra no `languagepacks.json` antes da primeira janela                                                  | 0036       |
| `fakl-microfone-webview.patch` | Libera o microfone (só áudio) nos webviews de extensão, para os comandos por voz; muda o hash da CSP de `pre/index.html`                                                                                                         | 0031       |
| `fakl-overlay.patch`           | Adiciona `faklOverlay.ts`: o overlay dos agentes (modo minimizado), uma janela sem moldura sempre no topo com pet e painel, ponte para o Core, bandeja e atalho global; `fakl-core-start.patch` o liga ao Core e às notificações | 0032       |

`fakl-overlay.patch` cria `faklOverlay.ts` e muda duas condições do
`lifecycleMainService.ts` (`setFaklKeepAlive`): com o overlay aberto, fechar a
última janela no Windows e no Linux não encerra o aplicativo, como no macOS. As
chamadas ao overlay ficam em `fakl-core-start.patch` (`createFaklOverlay`),
então os dois andam juntos e o `prepare.sh` aplica todos os `patches/*.patch`.
