# Especificação visual — Chat com agentes

- Status: proposta, parcialmente implementada (mapeamento revisado em 2026-10-14)
- Escopo: `extensions/fakl-core/src/webview/chat.ts`, `chat-ui.ts` e `chat.css`

## Objetivo

O chat deve permitir que a pessoa entenda, sem procurar:

1. com qual agente está falando;
2. o que ele está fazendo agora;
3. se existe alguma decisão esperando;
4. onde enviar a próxima instrução;
5. quais arquivos ficaram para revisar.

A direção visual é **console editorial**: uma interface escura, precisa e calma,
com boa hierarquia tipográfica, superfícies discretas e ciano/azul usados apenas
para foco, atividade e ação primária. Ela deve parecer parte da FaKL-Code IDE,
não um site encaixado dentro dela.

Esta especificação reorganiza o que o chat já oferece. Não adiciona anexos,
busca, edição de mensagem, timestamps ou dados que o protocolo atual não possui.

## Problemas da interface atual

- O seletor de conversa é o único contexto no cabeçalho; nome, estado, custo e
  local de trabalho aparecem longe dele, junto dos controles de envio.
- Agente, pasta, modo, modelo, raciocínio, estado, pausar, encerrar e enviar
  disputam a mesma linha e quebram de forma imprevisível em painéis estreitos.
- Mensagens, ferramentas, raciocínio e avisos têm pouca diferença de hierarquia.
- Uma permissão pendente pode se perder no histórico, embora seja a ação mais
  importante da tela.
- O painel de arquivos aberto ocupa o espaço mais valioso entre a conversa e o
  campo de mensagem.
- A conversa nova não conduz a configuração: apresenta seletores sem explicar
  claramente o impacto de worktree, pasta aberta e modo de permissão.
- Pausar, encerrar e enviar parecem ações do mesmo nível, apesar de terem risco
  e frequência diferentes.

## Estrutura da tela

O painel tem cinco regiões fixas em ordem visual:

```text
┌──────────────────────────────────────────────┐
│ [avatar] Codex                    [+ Nova] [⋯]│  1. Cabeçalho
│ ● Executando · Worktree · US$ 0,12      [⌄] │  2. Contexto
├──────────────────────────────────────────────┤
│                                              │
│  Histórico da conversa                      │  3. Conteúdo rolável
│  mensagens, atividade e avisos               │
│                                              │
├──────────────────────────────────────────────┤
│ ! Permissão necessária       [Negar] [Permitir]│ 4. Atenção, se houver
│ 3 arquivos para revisar                  [⌃] │
├──────────────────────────────────────────────┤
│ Peça uma tarefa ou faça uma pergunta…        │  5. Compositor
│ Perguntar                             [Enviar]│
└──────────────────────────────────────────────┘
```

Somente a região 3 rola. Cabeçalho, contexto, atenção e compositor permanecem
visíveis. Quando não há permissão ou arquivo pendente, a região 4 desaparece.

### 1. Cabeçalho da conversa

- Altura de 44 px, `padding` horizontal de 10 px e borda inferior discreta.
- À esquerda, avatar de 28 px com a inicial do agente, nome em 13 px/600 e
  ponto de estado. A cor do avatar vem do provedor quando ele puder ser
  identificado pelo `profileId`; o texto nunca depende dessa cor.
- Todo o bloco de identidade abre o seletor de conversas. Um chevron comunica
  que ele é interativo; não usar um `select` solto como título da tela.
- À direita, botão `+ Nova` como ação secundária. Abaixo de 360 px, mostrar
  apenas `+`, preservando `aria-label="Nova conversa"` e tooltip.
- O menu `⋯` contém **Pausar/Retomar** e **Encerrar agente**. Encerrar fica em
  vermelho somente no hover/foco e exige o mesmo fluxo atual; não deve ocupar
  permanentemente a área de composição.

O seletor aberto usa uma lista vertical com:

- `Nova conversa` no topo;
- sessões que esperam a pessoa primeiro;
- sessões ativas depois;
- sessões concluídas, falhas ou paradas por último, visualmente atenuadas;
- uma linha por sessão: avatar, nome, estado por extenso e custo, quando houver.

Não usar somente cor ou ícone para distinguir estados.

### 2. Faixa de contexto

Uma segunda linha de 32 px mostra o que normalmente precisa ser consultado,
mas não alterado a cada mensagem:

- estado atual;
- `Worktree` ou `Pasta aberta`;
- custo acumulado, se houver;
- botão `Configurar`/chevron no fim.

Ao expandir, a faixa revela numa grade os seletores existentes de modelo,
raciocínio e modo de permissão. Em largura menor que 360 px, cada campo ocupa
uma linha inteira. O caminho ou branch aparece como texto auxiliar truncado,
com o valor completo no tooltip.

O estado usa verbo legível em vez do valor cru quando necessário:

| Estado do protocolo    | Rótulo               | Tratamento         |
| ---------------------- | -------------------- | ------------------ |
| `preparando`           | Preparando           | ciano, pulso suave |
| `pensando`             | Pensando             | ciano, pulso suave |
| `executando`           | Executando           | ciano, pulso suave |
| `aguardando-permissão` | Precisa de permissão | âmbar              |
| `aguardando-você`      | Esperando você       | âmbar              |
| `ocioso`               | Pronto               | neutro             |
| `pausado`              | Pausado              | neutro atenuado    |
| `concluído`            | Concluído            | verde              |
| `falhou`               | Falhou               | vermelho           |
| `parado`               | Encerrado            | neutro atenuado    |

O pulso deve respeitar `prefers-reduced-motion: reduce` e não pode ser o único
indicador de atividade.

### 3. Histórico da conversa

- Fundo contínuo, sem cartões envolvendo toda resposta do agente.
- `padding` de 12 px, espaço de 16 px entre blocos e largura útil total do
  painel. Em painéis acima de 560 px, limitar o conteúdo a 680 px e centralizar.
- Resposta do agente alinhada à esquerda, com avatar de 22 px, nome e estado
  semântico apenas no início de cada bloco contínuo.
- Mensagem da pessoa alinhada à direita, com largura máxima de 88%, fundo
  elevado, borda sutil e raio de 10 px. Preservar quebras de linha.
- Parágrafos em 13 px com `line-height: 1.55`; metadados e atividade em 11 px.
- Links em ciano, código inline com fundo próprio e blocos de código com barra
  lateral, rolagem horizontal e fonte do editor.

#### Atividade e raciocínio

- Chamadas de ferramenta consecutivas formam visualmente uma única seção
  recolhível `Atividade`, mantendo cada item no DOM e a ordem original.
- Uma ferramenta pendente usa spinner/pulso discreto; concluída usa marca verde;
  falha usa ícone e texto vermelhos. Sempre manter o rótulo textual.
- `Raciocínio` começa recolhido, em superfície neutra, com título de 12 px. Ele
  não deve ter o mesmo peso visual da resposta final.

#### Avisos

- Avisos informativos aparecem como linha central curta, com ícone e texto
  atenuado; não usam balão de mensagem.
- Erros usam uma faixa com borda esquerda vermelha, título `Não foi possível`
  e a mensagem recebida. O erro de envio fica perto do compositor, não no topo.
- Pausa ou fim da sessão aparece como faixa entre histórico e compositor. Em
  sessão encerrada, o campo é substituído por `Esta conversa foi encerrada` e
  pelo botão `Nova conversa`.

### 4. Região de atenção

Essa região existe apenas para decisões pendentes e fica imediatamente acima
do compositor.

#### Permissão

- Enquanto não respondida, a permissão sai do fluxo visual do histórico e vira
  um cartão fixo âmbar com o rótulo `Permissão necessária`.
- Mostrar o título completo da ação, com quebra de linha e sem truncar.
- `Negar` é secundário e vem antes de `Permitir`, que é a ação primária.
- Após a resposta, o cartão some e permanece no histórico como registro
  compacto `Permitido` ou `Negado`.
- Foco de teclado vai para o cartão quando ele surge, sem disparar uma decisão.

#### Arquivos alterados

- A linha recolhida mostra `N arquivos para revisar`, estatística total quando
  disponível e chevron. Ela não começa aberta.
- Ao expandir, vira um drawer com altura máxima de 40% do painel. Cada linha
  mostra status `A/M/D`, caminho, `+adições −remoções` e ações com rótulo no
  tooltip.
- `Aplicar tudo` é primário; `Rejeitar tudo` é secundário e visualmente
  destrutivo. Conflitos usam âmbar/vermelho e o texto `Conflito`.
- Abrir o diff continua sendo a ação principal ao clicar no caminho.
- O drawer fecha automaticamente quando não há pendências.

### 5. Compositor

- Superfície elevada com borda de 1 px e raio de 10 px, separada das bordas do
  painel por 8 px. Ao focar, borda azul e halo de 2 px com baixa opacidade.
- `textarea` sem borda interna, altura inicial de 56 px e crescimento automático
  até 160 px; depois disso, rolagem interna.
- Placeholder curto: `Mensagem para o agente…`. A dica `Enter envia ·
Shift+Enter quebra a linha` aparece abaixo apenas quando houver espaço maior
  que 420 px ou no tooltip acessível.
- Rodapé do compositor: modo atual à esquerda e botão `Enviar` à direita.
- Em atividade ou pausa, o botão muda para `Pôr na fila`; o texto deixa claro
  que a mensagem não interrompe a ação atual.
- O botão enviar tem no mínimo 32 px de altura. Desabilitado, mantém contraste
  suficiente e não depende somente de opacidade.

## Conversa nova

Antes da primeira mensagem, o histórico dá lugar a uma introdução curta:

```text
Novo agente
Diga o resultado que você quer. Você pode ajustar como ele trabalha antes de enviar.

[ Agente: Codex                         ⌄ ]
[ Local:  Worktree (recomendado)        ⌄ ]
[ Modo:   Perguntar                     ⌄ ]

Worktree mantém suas mudanças isoladas até você revisar.
```

- Os três campos têm rótulo visível; placeholder ou `aria-label` isolado não
  substitui o rótulo.
- `Worktree` vem marcado como recomendado e sua explicação muda quando a pessoa
  seleciona `Pasta aberta`.
- Perfis indisponíveis aparecem abaixo, numa seção `Agentes indisponíveis`, com
  o motivo e a ação de instalação existente.
- Sem pasta aberta, substituir o formulário por estado vazio: ícone de pasta,
  `Abra uma pasta para iniciar um agente` e instrução curta. Não deixar campos
  aparentemente utilizáveis.
- O compositor é a própria primeira mensagem; não criar um segundo campo.

## Tokens visuais

O chat deve respeitar o tema ativo da IDE. A paleta FaKL serve de fallback e
de referência, não como substituição forçada das variáveis do VS Code.

| Uso                | Variável preferida                 | Fallback FaKL Noite |
| ------------------ | ---------------------------------- | ------------------- |
| fundo              | `--vscode-sideBar-background`      | `#0b0f16`           |
| superfície         | `--vscode-editorWidget-background` | `#0f141d`           |
| superfície elevada | `--vscode-input-background`        | `#0a0e14`           |
| borda              | `--vscode-widget-border`           | `#263041`           |
| texto              | `--vscode-foreground`              | `#e6edf3`           |
| texto secundário   | `--vscode-descriptionForeground`   | `#8b949e`           |
| primária/foco      | `--vscode-focusBorder`             | `#2563eb`           |
| atividade/link     | `--vscode-textLink-foreground`     | `#22d3ee`           |
| sucesso            | `--vscode-testing-iconPassed`      | `#4ade80`           |
| atenção            | `--vscode-list-warningForeground`  | `#fbbf24`           |
| erro               | `--vscode-errorForeground`         | `#f87171`           |

Regras gerais:

- grade de espaçamento: 4, 8, 12, 16 e 24 px;
- raios: 6 px para controles, 10 px para mensagens e compositor;
- sem gradientes, vidro fosco ou sombras fortes dentro da barra lateral;
- tipografia `--vscode-font-family`; código usa `--vscode-editor-font-family`;
- transições de 120–160 ms somente para cor, borda, expansão e opacidade.

## Responsividade

| Largura do painel | Comportamento                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 280–359 px        | botões secundários viram ícones; contexto e configuração em uma coluna; ações de permissão ocupam a largura disponível |
| 360–519 px        | layout padrão; `+ Nova` tem rótulo; campos expandidos continuam em uma coluna                                          |
| 520 px ou mais    | configuração em duas colunas; dica de teclado visível; conteúdo limitado a 680 px                                      |

O chat não deve produzir rolagem horizontal entre 280 e 720 px. Caminhos,
branches e nomes longos truncam visualmente, mas continuam disponíveis em
tooltip e para tecnologia assistiva.

## Acessibilidade e teclado

- Ordem de tabulação: seletor de conversa, nova conversa, menu, contexto,
  histórico interativo, decisão pendente, arquivos, campo e enviar.
- Alvos interativos com pelo menos 28 × 28 px; ações primárias e decisões com
  pelo menos 32 px de altura.
- Foco visível de 2 px com contraste mínimo de 3:1. Texto normal mantém 4,5:1.
- `role="log"` permanece no histórico; atualizações em streaming não devem
  anunciar o texto inteiro novamente a cada fragmento.
- Estado, sucesso, falha e conflito sempre têm texto ou ícone além da cor.
- `Esc` fecha seletor, configuração ou drawer; não limpa o rascunho.
- `Enter` envia e `Shift+Enter` quebra linha, preservando IME.
- Respeitar zoom da IDE, fonte configurada e `prefers-reduced-motion`.

## Estados obrigatórios

A implementação deve prever visualmente:

- carregamento inicial;
- conversa nova com e sem pasta aberta;
- nenhum agente instalado;
- sessão preparando, ativa, pausada e encerrada;
- mensagem em envio e em fila;
- ferramenta pendente, concluída e falha;
- permissão pendente, permitida e negada;
- arquivos pendentes, aplicados, rejeitados e em conflito;
- erro transitório de envio.

## Critérios de aceite visual

1. Em até dois segundos, uma pessoa nova identifica agente, estado e campo de
   envio sem abrir menus.
2. Uma permissão pendente permanece visível mesmo com um histórico longo.
3. Pausar e encerrar não competem visualmente com enviar.
4. A tela não tem mais de uma ação primária azul por região.
5. Em 280 px de largura não existe rolagem horizontal nem controle cortado.
6. Em 520 px ou mais, mensagens não se esticam além de 680 px.
7. Arquivos alterados não reduzem permanentemente o histórico quando o drawer
   está recolhido.
8. Todos os estados são compreensíveis em escala de cinza.
9. Todo controle é alcançável e acionável por teclado, com foco visível.
10. A interface continua legível com o tema FaKL Noite e com um tema claro do
    VS Code.

## Mapeamento para a implementação atual

| Elemento atual                                                         | Tratamento especificado                                            | Situação                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `.header` com `.session-btn` (`sessionButton`)                         | cabeçalho de identidade com seletor em popover                     | feito: o seletor abre um menu em popover                        |
| `.status`                                                              | faixa de contexto com rótulo de estado, local e custo              | a fazer                                                         |
| `.options-bar` no compositor (`modePill` e `.session-options`)         | painel `Configurar` recolhível                                     | a fazer: as opções ficam sempre visíveis na barra               |
| `.messages`                                                            | única região rolável, com agrupamento visual por tipo              | a fazer                                                         |
| `.permission`                                                          | região fixa de atenção enquanto pendente; registro compacto depois | a fazer                                                         |
| `.changes`                                                             | drawer recolhido acima do compositor                               | a fazer                                                         |
| `.banner` e `.error`                                                   | faixas contextuais próximas da ação afetada                        | a fazer                                                         |
| `.composer`                                                            | superfície única com textarea e rodapé de ações                    | a fazer                                                         |
| `pauseButton` no cabeçalho e encerrar em **Mais ações** (`moreButton`) | menu de ações da sessão                                            | parcial: encerrar já está no menu; pausar continua no cabeçalho |

O protocolo entre webview e extensão pode permanecer igual. Agrupamento de
ferramentas, ordenação visual de sessões, rótulos de estado e regiões
recolhíveis são responsabilidades de apresentação do webview.
