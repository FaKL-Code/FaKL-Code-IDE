# Modo minimizado (overlay dos agentes)

Uma janela pequena, sempre no topo, que deixa você acompanhar e comandar os
agentes sem a IDE inteira na tela, no estilo do "pet" do Codex. O objetivo é
o uptime dos agentes: ninguém fica parado esperando você porque a decisão,
a próxima tarefa ou a troca de conta estão a um clique, por cima de qualquer
outro programa. Decisão de arquitetura na [ADR 0032](../adr/0032-modo-minimizado.md).

## Formas

- **Pet** (72×72): um bichinho/bolha arrastável, preso à borda mais próxima ao
  soltar, com a posição lembrada entre sessões. Mostra, sem abrir nada:
  - um anel de estado: cinza (ninguém trabalhando), animado (trabalhando),
    âmbar pulsando (alguém espera você), vermelho (falhou ou parou por limite);
  - um selo com quantos agentes esperam você, ou quantos trabalham;
  - um balão curto que aparece por alguns segundos quando algo muda
    ("Revisor terminou", "Maestro pede permissão"). Enquanto ele está na
    tela, a janela se alarga para o lado do centro da tela (longe da borda
    em que o pet está preso) e volta a 72×72 quando ele some; na área vazia
    os cliques passam para o programa de baixo (no Linux, não passam).
    Clique abre o painel; arrastar move; duplo clique abre a IDE.
- **Painel** (≈380×560): a forma expandida, ancorada no pet. `Esc` ou clicar
  fora recolhe para o pet.

## O que o painel faz

Organizado para atender primeiro o que trava agentes.

1. **Esperando você** (topo, sempre visível quando não vazio)
   - pedidos de permissão com Permitir / Negar (e "Permitir sempre nesta
     sessão" quando o agente oferece);
   - decisões do maestro (`ask_human`) com as opções em botões, a
     recomendada primeiro;
   - agentes parados por limite (sessão de 5 h, teto diário) com "Trocar de
     conta e continuar" e "Continuar".
2. **Agentes** — vivos agrupados em _trabalhando_ e _ociosos_; encerrados
   recolhidos. Cada linha: nome, perfil, estado, última fala, tempo desde a
   última atividade, anel de contexto e custo. Ações rápidas na linha:
   interromper, parar, abrir na IDE.
3. **Conversa compacta** — ao tocar num agente: as últimas falas em markdown
   (ferramentas e pensamentos recolhidos), compositor que não perde o
   rascunho, enviar, interromper, trocar modo (autopilot/perguntar) e modelo.
4. **Nova tarefa / nova conversa** — compositor rápido com pasta (as
   recentes primeiro), perfil e modo; `Ctrl+Enter` envia. Um atalho global
   (`Ctrl+Alt+Espaço`) abre o painel já neste compositor, de qualquer
   programa.
5. **Tarefas** — execuções do maestro com rodada atual, subagentes, custo e
   veredito; abrir o diff na IDE.
6. **Uso** — gasto do dia contra o teto de cada provedor, sessão de 5 h e
   limite semanal, conta do Claude ativa e troca com um clique.
7. **Rodapé** — estado da conexão com o Core, "Abrir IDE", não perturbe
   (silencia balões e som), fixar painel aberto, sair.

## Comportamento com a IDE

- **Entrar no modo minimizado**: comando `FaKL: Modo minimizado`, botão na
  barra de status e o atalho `Ctrl+Alt+Shift+M` na IDE (`Ctrl+Alt+M` já abre a Mesa). As janelas da IDE são
  escondidas (não fechadas: o host de extensões e o estado continuam) e o
  pet aparece.
- **Voltar**: "Abrir IDE", duplo clique no pet, "Abrir na IDE" de um agente
  (abre a conversa dele) ou o ícone na bandeja.
- **Fechar a IDE com o overlay aberto** não encerra o FaKL-Code: a janela
  fecha de verdade, mas o Core, os agentes e o overlay continuam (o pet
  aparece), com um ícone na bandeja (Mostrar overlay, Abrir IDE, Não
  perturbe, Sair). "Sair" (ou Arquivo > Sair numa janela) segue o diálogo de
  agentes trabalhando da ADR 0006; um quit cancelado (arquivo não salvo)
  deixa o overlay como estava.
- **Não perturbe** tem um valor só, guardado pelo processo principal junto
  com a posição do pet: o rodapé do painel e a bandeja mudam o mesmo.
- **Aparece sozinho**: com todas as janelas da IDE escondidas ou
  minimizadas, um pedido de permissão ou decisão do maestro (`run.decision`
  pendente) mostra o pet e o balão.
- As notificações nativas da ADR 0006 continuam; com o overlay visível, os
  avisos ficam no balão do pet e a nativa só sai para pedidos urgentes.

## Acessibilidade e ergonomia

- Navegação completa por teclado no painel, foco visível, `Esc` recolhe.
- Cores do tema FaKL Noite da IDE (superfícies, bordas, texto, estados e a
  pilha de fontes do workbench), sem trocar para claro com o sistema;
  contraste AA; respeita `prefers-reduced-motion` (anel sem animação).
- Opacidade ajustável do pet e opção de esconder o pet enquanto nada muda.

## Fases

1. **Esta entrega**: pet + painel com Esperando você, Agentes, Conversa
   compacta, Nova conversa, Uso e rodapé; janela, ponte, bandeja e atalho
   global no processo principal; comando de minimizar e "Abrir na IDE" pela
   extensão.
2. **Depois**: fila de próximas tarefas que dispara quando um agente fica
   ocioso; continuar sozinho após o limite da sessão com troca automática de
   conta; aviso de agente ocioso há mais de N minutos; som; iniciar com o
   sistema só com o Core e o overlay.

## Contrato entre o overlay e o processo principal

O overlay é uma página local (`extensions/fakl-core/dist/overlay/`) numa
`BrowserWindow` sem moldura, transparente e sempre no topo, criada pelo
processo principal (`patches/fakl-overlay.patch`). Ela não abre socket: o
processo principal conecta ao Core (endereço do `ready`, token que ele mesmo
gerou), faz o `session.hello` e repassa as linhas JSON-RPC.

O preload (`dist/overlay/preload.cjs`) expõe `window.faklOverlay`:

```ts
interface OverlayBridge {
  /** Uma mensagem JSON-RPC para o Core, sem o `\n` (a conexão já está autenticada). */
  send(frame: string): void;
  /** Mensagens do Core, uma por chamada, sem o `\n`. */
  onFrame(listener: (frame: string) => void): void;
  /** `online` depois do `session.hello`; `offline` quando o Core cai (o principal reconecta). */
  onStatus(listener: (status: 'online' | 'offline') => void): void;
  /** Troca a forma: o principal redimensiona e reposiciona a janela. `balao` é o pet com o balão ao lado. */
  setMode(mode: 'pet' | 'painel' | 'balao'): void;
  /** Lado do pet para onde o balão abre (o do centro da tela); reenviado ao carregar e quando o pet muda de borda. */
  onSide(listener: (side: 'esquerda' | 'direita') => void): void;
  /** Com o balão: `true` quando o ponteiro está na área vazia, para os cliques passarem (Windows e macOS). */
  setClickThrough(through: boolean): void;
  /** "Não perturbe": o principal guarda no userData e atualiza a bandeja. */
  setQuiet(quiet: boolean): void;
  /** O valor atual ao carregar e cada mudança, venha do painel ou da bandeja. */
  onQuiet(listener: (quiet: boolean) => void): void;
  /** Esconde o overlay (fica na bandeja). */
  hide(): void;
  /** Sai do FaKL-Code, com o diálogo de agentes trabalhando. */
  quit(): void;
  /** O principal pede uma forma (atalho global abre o compositor). */
  onCommand(listener: (command: 'compor' | 'painel' | 'pet') => void): void;
}
```

Canais IPC: `fakl-overlay:send`, `fakl-overlay:mode`,
`fakl-overlay:click-through`, `fakl-overlay:set-quiet`, `fakl-overlay:hide`,
`fakl-overlay:quit` e `fakl-overlay:ready` (do overlay ao principal);
`fakl-overlay:frame`, `fakl-overlay:status`, `fakl-overlay:command`,
`fakl-overlay:side` e `fakl-overlay:quiet` (do principal ao overlay). O
preload confere o tipo de cada valor nos dois sentidos. Ao receber
`fakl-overlay:ready`, o principal reenvia o estado da conexão, o "Não
perturbe" e o lado do balão.

Pelo Core:

- `ui.reveal { sessionId? }` — traz a IDE para a frente (mostra as janelas
  escondidas, ou abre uma) e, com `sessionId`, a extensão abre a conversa
  daquele agente (evento `ui.reveal`). O Core guarda essa conversa por até
  2 minutos; um `ui.reveal` sem `sessionId` a descarta.
- `ui.takeReveal { sessionId? } → { sessionId } | null` — a extensão reclama a
  conversa pendente, que é entregue uma vez só: ao receber o evento (com o
  `sessionId` dele; com várias janelas, só uma abre) e ao conectar numa
  janela nova (sem `sessionId`), que é o caso de "Abrir na IDE" sem janela
  aberta.
- `ui.overlay { action: 'show' | 'hide' | 'toggle', minimizeIde?: boolean }` —
  a extensão pede o modo minimizado; o Core repassa ao processo principal.
- Mensagens ao processo principal (`ToHost`): `{ type: 'overlay', action,
minimizeIde }`, `{ type: 'reveal' }` e `{ type: 'notify', urgent }`, que
  também sai para decisões pendentes do maestro (`run.decision`).
