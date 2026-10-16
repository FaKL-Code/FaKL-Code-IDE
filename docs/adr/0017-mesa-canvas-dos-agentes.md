# 0017. Mesa: o canvas dos agentes como tela principal

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-106, RF-107, RF-108, RF-203

## Contexto

A interface pareceu simples demais, e pediu-se avaliar a UX e a UI do
Maestri e aplicar os mesmos conceitos visuais na IDE inteira, não só as
funções. Até aqui os agentes apareciam numa árvore na barra lateral e
conversavam num chat estreito. A relação maestro → subagentes não aparecia em
lugar nenhum. Os worktrees de cada agente também não.

O que o Maestri faz bem:

- uma mesa infinita é a tela principal;
- cada agente é uma janela viva que dá para arrastar;
- cabos mostram quem chamou quem;
- worktrees são "andares" com estado e um fluxo para pousar o trabalho;
- dá para trazer um agente para o centro e devolvê-lo;
- atalhos de uma tecla;
- navegação até quem pede atenção;
- um minimapa.

O que ele faz mal, segundo as próprias análises de uso, são ícones sem rótulo
na barra de ferramentas.

## Decisão

A extensão `fakl-core` ganha a **Mesa**, um painel webview que abre ao abrir uma
pasta (`fakl.mesa.abrirAoIniciar`), pelo botão na mesa de controle, ou com
`Ctrl+Alt+M`.

- **Cartões.** Cada sessão é um cartão com:
  - avatar na cor do provedor;
  - nome e selo do papel;
  - ponto de estado;
  - seletores de modelo e de modo;
  - uso;
  - a conversa ao vivo;
  - a barra de permissão com Permitir e Negar;
  - os arquivos alterados;
  - um campo para mandar mensagem.

  O cartão se arrasta pelo título, muda de tamanho pelo canto e encaixa numa
  grade de 20.

- **Cabos.** Cada subagente fica ligado ao maestro que o chamou. O papel e o
  pai vêm de `Run.agentes`. O cabo é uma curva com barriga de corda, na cor do
  papel, e fica animado enquanto o subagente trabalha. Com a ferramenta Cabo, o
  usuário também liga cartões e notas por conta própria.
- **Andares.** A barra lateral tem um andar por worktree, ou a pasta aberta,
  com um destes estados: trabalhando, esperando você, pronto para revisar ou
  concluído. Na mesa, cada andar aparece como uma área tracejada em volta dos
  seus cartões. "Pousar" abre uma folha com os arquivos, o diff de cada um,
  Aplicar e Descartar.
- **Navegação.** As ferramentas têm rótulo e atalho de uma tecla:
  - Selecionar (V)
  - Mover (H, ou segure espaço)
  - Agente (N)
  - Tarefa (T)
  - Nota (O)
  - Cabo (L)
  - Atenção (A)
  - Arrumar (R)
  - Enquadrar (F)

  O resto da navegação:
  - o botão direito abre o menu Adicionar;
  - a roda move a mesa e Ctrl com a roda dá zoom;
  - há um minimapa;
  - um duplo clique no título amplia o cartão no centro, e Esc o devolve;
  - um selo mostra quantos agentes esperam você;
  - de longe, os cartões escondem o miolo.

- **Arrumar.** Põe o maestro em cima e os subagentes numa fileira embaixo,
  recursivamente. Cartões novos de subagentes já nascem embaixo do pai.
- **Notas.** Notas em Markdown ficam na mesa. O layout (posições, notas, cabos
  e visão) é salvo por pasta em `workspaceState`.
- **Visual.** A Mesa usa a paleta fixa da marca:
  - fundo `#07090d` com grade de pontos;
  - cartões `#0f141d`;
  - azul `#2563eb` e ciano `#22d3ee`;
  - brilho na cor do provedor enquanto o agente trabalha;
  - âmbar para quem espera você.

  Não há imagens geradas por código. Os avatares são as iniciais.

Na segunda parte, a Mesa ganhou:

- **Menções.** No campo de mensagem, `@` lista os outros agentes, e a última
  resposta de quem foi citado segue junto com a mensagem. `#` lista os
  arquivos da pasta.
- **Prévias.** A ferramenta Prévia (P) põe na mesa um navegador pequeno com o
  app rodando em localhost (ou um endereço https). Ele tem endereço, botão de
  recarregar e botão de abrir fora. O webview só permite frames de localhost,
  127.0.0.1 e https.
- **Anéis de uso.** A barra lateral mostra um anel por provedor com o gasto do
  dia contra o teto (`costs.summary`). Fica vermelho quando bate no teto.

A IDE inteira ganha o mesmo visual:

- **Tema.** O tema de cores **FaKL Noite** cobre a interface, o editor, o
  terminal e a sintaxe com a mesma paleta. Quem nunca escolheu um tema passa a
  usá-lo. Quem já tem um recebe um convite, uma vez só.
- **Foco.** O botão Foco na Mesa (`fakl.mesa.focus`) recolhe as barras
  laterais e o painel, e deixa só a Mesa.

A Mesa usa o mesmo `AgentControl` do chat e da árvore, então os três ficam
sempre iguais. As regras sem DOM ficam em `src/webview/mesa-model.ts` e têm
testes. Isso cobre a grade, a arrumação em árvore, os andares, a ordem de
atenção, os cabos e o enquadramento.

## Consequências

- O chat lateral continua para quem prefere uma conversa só. A Mesa é a visão
  de várias conversas ao mesmo tempo.
- O app do celular passa a usar a mesma paleta:
  - cabeçalho e barra de abas com vidro fosco;
  - abas com ícones;
  - agentes com avatar na cor do provedor e ponto de estado pulsando;
  - decisões em âmbar.
- Fica para depois encaixar o cartão ampliado numa borda.
- O retainContextWhenHidden da Mesa mantém o estado ao trocar de aba. O custo é
  memória, não CPU, porque nada roda sem eventos.
