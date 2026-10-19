# Acessibilidade

Requisito RNF-14 do [SDD](sdd.md): as telas que dependiam do ponteiro (o grafo do vault, o cyber café
e o app do celular) agora têm teclado, rótulos e anúncios para leitor de tela. A Mesa e o chat já
tinham e servem de modelo de estilo.

Nada disto foi ouvido num leitor de tela real nem medido contra a WCAG: o que há é a estrutura
(papéis, rótulos, regiões `aria-live`, foco) e testes da lógica. Veja "O que ainda falta".

## Grafo do vault

O canvas é um alvo focável (`role="application"`, com o total de notas e links no rótulo).

| Tecla               | O que faz                                                              |
| ------------------- | ---------------------------------------------------------------------- |
| Tab                 | entra no grafo; o foco começa na nota aberta no editor, ou na primeira |
| Setas               | levam à nota mais próxima naquela direção (cone de 60 graus)           |
| Page Down / Page Up | próxima e anterior nota na lista em ordem alfabética                   |
| Home / End          | primeira e última nota da lista                                        |
| Enter               | abre a nota com foco                                                   |
| `+` / `-` / `0`     | aproxima, afasta e reinicia a vista                                    |
| Esc                 | sai do grafo e leva o foco ao filtro                                   |

- A ordem das setas é por posição na tela, com desconto para notas ligadas à atual (a seta segue um
  link quando há um no caminho). Como a posição muda com o layout, quem usa leitor de tela navega
  melhor pela lista: Page Down e Page Up, e a lista de links abaixo.
- Cada nota focada é lida numa região `aria-live=polite`: título, pasta e os primeiros links. Logo
  depois do canvas na ordem de Tab há a lista de links da nota; escolher um leva o foco a ele.
- O filtro de notas e os botões de zoom (menos, 1:1, mais) têm rótulo. O anel de foco é desenhado
  no canvas, na cor de foco do tema.
- Com `prefers-reduced-motion`, o layout assenta de uma vez e a tela fica parada.

## Cyber café (painel da IDE)

- O canvas ganha um resumo no rótulo ("3 agentes: 1 esperando você, 2 trabalhando").
- Uma lista escondida mostra quem está no café e o estado de cada agente (chegando, trabalhando,
  parado, esperando permissão, esperando você, pausado, na pausa, falhou, parou, limite atingido).
  Enter ou Espaço num item abre a conversa, o mesmo que o clique no personagem. A lista aparece na
  tela quando um item recebe o foco.
- Uma região `aria-live=polite` anuncia as mudanças de estado, no máximo uma mensagem a cada 5
  segundos. O que muda nesse intervalo vira uma frase só (até 3 nomes, depois "e mais N mudanças"),
  quem precisa de você vem primeiro, pensar e executar contam como "trabalhando" e uma mudança que
  volta ao que já foi dito some. O primeiro retrato do café não é anunciado.
- Os botões `+ Agente` e `+ Tarefa` têm rótulo e foco visível, e a faixa de telas dos agentes
  mantém o foco e o que foi digitado quando se redesenha.
- Com `prefers-reduced-motion`, o café desenha 4 quadros por segundo e o gato, a sinuca, o
  fliperama e as pausas por tédio ficam parados; o estado dos agentes continua atualizado.

### Cozinha do CI

- A cozinha tem rótulo próprio ("CI: 1 falhando, 2 rodando, 7 verdes seguidos") e uma lista escondida
  com uma linha por execução; Enter ou Espaço abre a execução no painel de Actions.
- Os resultados (passou, falhou, esperando aprovação) entram na mesma região `aria-live` dos agentes,
  na mesma frase agrupada. "Começou" e "entrou na fila" não são anunciados, e o primeiro retrato
  não é anunciado.
- Com `prefers-reduced-motion`, a bancada fica parada e o estado se lê de uma imagem fixa.

## App do celular

- As abas têm nome acessível com a contagem de pendentes ("Caixa de entrada, 2 pendentes"), e a
  aba atual leva `aria-current="page"`.
- Uma região `aria-live=polite` avisa quando chegam pedidos ou decisões esperando você e quando a
  conexão com a IDE cai ou volta, no máximo a cada 3 segundos. As mensagens da conversa já eram
  anunciadas pelo `role="log"` dela.
- Ao abrir uma tela de detalhe (uma conversa, por exemplo), o foco vai para o título dela; ao
  voltar, volta ao botão que a abriu (ou à aba atual, se ele já não existe).
- A lista de agentes do café tem uma versão escondida com botões que abrem a conversa.
- Alvos de toque: botões de ícone, botões pequenos, copiar código, voltar ao fim e o microfone do
  campo de voz passaram a ter 44 px.
- Com `prefers-reduced-motion`, animações e transições do app ficam praticamente instantâneas.

## O que ainda falta

- Teste com leitor de tela real (NVDA, VoiceOver, TalkBack): os textos e a ordem de leitura foram
  pensados, não ouvidos.
- Medição de contraste e das demais regras da WCAG; o canvas do grafo e do café usam cores fixas.
- Nenhum teste automatizado de DOM: os testes cobrem só a lógica pura (ordem de navegação do
  grafo, textos e limite de frequência dos anúncios), porque o repositório não tem jsdom.
- O café e o grafo continuam sendo, no desenho, coisas visuais: a lista escondida e os anúncios
  trazem a informação, mas não reproduzem a cena (quem está jogando sinuca, por exemplo).
- Mesa, chat e demais painéis não foram revistos neste trabalho.
- A faixa de conversas externas do café e as telas de pareamento do celular não foram revistas.
