# Roadmap

O que falta e para onde a FaKL-Code vai, na ordem em que faz mais diferença. Vem de uma auditoria
dos requisitos do [SDD](docs/sdd.md) contra o código (versão 0.1.5, em 2026-10-18) e de pesquisa
sobre o que outras ferramentas oferecem. Marcamos **[F]** o que foi verificado no código ou em
fonte oficial, **[B]** o que vem de blog ou relato e **[I]** o que é inferência nossa. Nada aqui é
promessa de data: o projeto tem uma pessoa mantendo, e contribuições aceleram tudo (veja
[como contribuir](CONTRIBUTING.md)).

## Já existe

Maestro e subagentes, um worktree por agente, Mesa e cyber café, vault em Markdown com busca
semântica, GitHub da conta inteira, SSH, Hostinger, Lovable, e-mail, controle pelo celular com
relay próprio, voz, jornada de configuração, Doctor, tour, auto-update no Windows, português e
inglês. O SSH inclui encaminhamento de porta (`ssh.forward.*`, só pela IDE, RF-504).
Playbooks com critério de pronto (o da nota de origem se soma ao do playbook), vault que não
versiona o estado do Obsidian (`workspace*.json`, cache) e embed de notas `![[nota]]` e
`![[nota#Título]]` na prévia. Em revisão: placar de agentes e varredura de skills e MCPs (ADRs 0042 e 0043).
Café do CI: as execuções do GitHub Actions de até 5 repositórios viram a cozinha do café, só leitura
(ADR 0051, [docs/cafe-do-ci.md](docs/cafe-do-ci.md)).

## Agora

- **Teste de fumaça da IDE compilada no CI.** Entrou no job `fumaca` do `build.yml`, depois de um
  bug que deixou o servidor MCP e a CLI quebrados de v0.1.0 a v0.1.3 sem aviso.
- **Termos dos provedores.** [docs/termos-dos-provedores.md](docs/termos-dos-provedores.md)
  registra o que cada provedor diz sobre clientes de terceiros e o que a IDE faz. Em aberto: a regra
  da Anthropic para adaptadores sobre o Agent SDK com login de assinatura **[B/F]**.
- **Distribuição.** winget (PR enviado), Scoop e tap do Homebrew; build experimental para Linux
  (`.tar.gz`, `.deb` e `.rpm`) e testes também em macOS e Linux.
- **Privacidade.** Inventário do que a IDE consulta na rede e um interruptor único.

## Depois

- Notarização no macOS (exige a conta paga da Apple; libera o auto-update no Mac e o cask oficial
  do Homebrew **[F]**) e assinatura no Windows (o SignPath Foundation recusou o pedido).
- Terminal ao vivo por agente: terminal de leitura entregue (ADR 0046); PTY interativo continua pendente, junto com o adaptador para CLIs sem ACP.
- Medição de desempenho (RNF-02 a RNF-04) rodando de forma agendada.
- macOS Intel e canal insider.
- Teste de acessibilidade com leitor de tela real (NVDA, VoiceOver, TalkBack) no grafo do vault, no café
  e no app do celular: o teclado e os anúncios já existem (RNF-14, veja `docs/acessibilidade.md`), mas
  nunca foram ouvidos num leitor de verdade.
- Busca semântica do vault por API, Git LFS no vault.

## Mais adiante

- IDE completa no navegador (servidor web do Code-OSS compilado e exposto pelo canal cifrado).
- Agentes em segundo plano na sua própria VPS, com a IDE como painel.
- Sandbox opcional por container ou microVM para agentes.
- Multiprojeto e vault de equipe ([especificação](docs/especificacao-multiplos-projetos.md)).
- Esteira de revisão de código de agente: checklist, testes antes do diff e resumo de risco.

## O que a IDE não vai fazer

- Falar com o Marketplace da Microsoft nem rodar as extensões proprietárias dela (Pylance, Remote-SSH,
  C# Dev Kit, Live Share **[B]**); o Open VSX e o SSH nativo cobrem parte disso.
- Copiar, guardar ou intermediar o login de assinatura de nenhum provedor.
- Telemetria.

## Como ajudar

Escolha um item, abra uma issue dizendo que vai pegar e envie um PR pequeno. Os mais acessíveis para
começar: teste com leitor de tela no café e no grafo, testes do painel de remoto, traduções (o espanhol é o
próximo idioma natural **[I]**), e a documentação dos fluxos que você usa.
