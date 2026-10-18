---
titulo: Instalação
descricao: Plataformas, distribuição e os primeiros passos depois de instalar.
ordem: 2
---

## Plataformas

| Sistema | Instalador    | Requisito                    |
| ------- | ------------- | ---------------------------- |
| Windows | x64           | Windows 10 ou 11, 64 bits    |
| macOS   | Apple Silicon | Mac com chip M1 ou mais novo |

Baixe na página [Baixar](/download/) ou nas [Releases do GitHub](https://github.com/FaKL-Code/FaKL-Code-IDE/releases) e confira o hash em `SHA256SUMS.txt`. Os instaladores ainda não têm assinatura digital:

- **Windows:** o SmartScreen mostra "O Windows protegeu o computador". Clique em **Mais informações** e em **Executar assim mesmo**.
- **macOS:** descompacte o `.zip`, mova o app para Aplicativos e, uma vez, abra com o botão direito, **Abrir**. Também funciona rodar `xattr -dr com.apple.quarantine "/Applications/FaKL-Code IDE.app"` no Terminal.

## Depois de instalar

1. **Instale as CLIs dos agentes que quiser usar** e entre com a sua conta no Claude Code e no Codex. A IDE usa os logins deles; o Core não lê credenciais. O Gemini CLI só funciona com uma chave de API do Google AI Studio (o login com conta Google pessoal não é mais aceito).
2. **Modelos locais (opcional):** instale o Ollama ou o LM Studio. O adaptador local da IDE fala com eles e dá ao modelo as ferramentas de ler, buscar, editar e rodar comandos dentro do worktree.
3. **Ponha a CLI no PATH:** rode o comando **Pôr a CLI fakl no PATH do sistema** pela paleta de comandos para usar `fakl` em qualquer terminal.
4. **Entre no GitHub** pelo comando **Entrar no GitHub** e, se usar, **Conectar à Hostinger**.
5. **Configure o vault** com **Configurar o vault**, apontando para a sua pasta de notas.
6. **Pareie o celular** com **Parear aparelho para acesso remoto**, se quiser acompanhar de longe.

## Atualizações

No Windows, a IDE procura versão nova sozinha, baixa o instalador e pede para reiniciar. A v0.1.0 não tem essa função: instale a v0.1.4 ou mais nova uma vez à mão, e daí em diante o app se atualiza. No macOS a IDE avisa que há versão nova e abre a página de download; instale como na primeira vez. Para desligar a verificação, use a configuração `update.mode` com o valor `none`.
