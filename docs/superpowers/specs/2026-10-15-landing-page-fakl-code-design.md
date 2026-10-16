# Landing page da FaKL-Code IDE

## Intenção

Apresentar a FaKL-Code IDE como o lugar onde agentes de IA trabalham em paralelo
com contexto, limites e supervisão humana. A página deve fazer a pessoa entender
em poucos segundos a diferença central do produto: os agentes trabalham em
worktrees próprios, a Mesa mostra o que acontece e o resultado volta para o
fluxo de desenvolvimento.

Público: pessoas desenvolvedoras que já usam Claude, Codex ou Gemini no dia a
dia. Objetivo principal: levar a pessoa a conhecer e instalar a IDE. A página
terá uma demonstração visual forte, com navegação e textos que continuam claros
quando o movimento está desligado.

Não é objetivo transformar a página num catálogo de cada comando, prometer
integrações futuras, nem esconder o produto atrás de uma experiência 3D pesada.
Evitar promessas de IDE no navegador, interface em inglês ou automação sem
supervisão: não são capacidades atuais.

## Ideia central

O `>_` ciano da identidade funciona como portal. A câmera acompanha o prompt
através do monitor de um agente no cyber café em pixel art, entra na IDE e
percorre as superfícies reais do produto. O café representa os agentes em
atividade; a IDE mostra o trabalho, os limites e as decisões. A página retoma o
filme de lançamento como linguagem e universo visual, sem ser uma cópia do
filme.

Frase principal, reaproveitada do filme:

> Seus agentes de IA trabalham juntos, e você vê tudo acontecer.

## Sistema visual

| Token            | Uso                               | Cor       |
| ---------------- | --------------------------------- | --------- |
| Fundo            | palco principal e respiros        | `#0D1117` |
| Superfície       | painéis e molduras                | `#1F2937` |
| Borda            | separação de painéis              | `#374151` |
| Primária         | ações e chamadas secundárias      | `#2563EB` |
| Ciano            | prompt, cursor, foco e transições | `#06E0FF` |
| Texto            | títulos e leitura                 | `#E5E7EB` |
| Texto secundário | apoio e metadados                 | `#A1A1AA` |

Inter é a fonte de leitura. JetBrains Mono 700 fica reservada para títulos de
impacto, comandos, valores e rótulos funcionais. Usar o logo vetorial existente;
nunca reconstruí-lo com texto. O café mantém sua própria paleta e pixel art sem
suavização. Nas capturas de interface, preservar as cores próprias dos
provedores; o ciano é o acento dos grafismos da página, não uma recoloração do
produto.

## Estrutura da página

### 1. Hero: o monitor como portal

Tela inicial escura, com o logo no topo e navegação curta: Produto, Recursos,
Café e Baixar. No palco, o prompt `>_` pisca e digita a frase principal. Em
seguida, uma composição isométrica do café entra no enquadramento; vemos vários
agentes em mesas e miniaturas reais de atividade nos monitores. Um monitor
específico cresce até preencher a tela e revela a Mesa da IDE.

Texto: “Seus agentes de IA trabalham juntos, e você vê tudo acontecer.”
Complemento: “Claude, Codex, Gemini e modelos locais, cada um no seu worktree.”
CTA primário: “Baixar FaKL-Code”. CTA secundário: “Assistir ao filme”. O destino
do download deve apontar para a página de releases/instaladores confirmada no
momento da implementação.

O hero deve parecer a abertura de um filme de lançamento: tipografia cinética,
parallax de profundidade, câmera que cruza o monitor e uma trilha de movimento
contínua. O CTA e a frase precisam estar legíveis desde o primeiro estado, sem
esperar a animação terminar.

### 2. A Mesa: trabalho paralelo, visível

O hero pousa numa captura fiel da Mesa. Três agentes aparecem em worktrees
separados; uma tarefa do Maestro se desdobra em subagentes. Estados reais,
indicadores de custo e uma decisão pendente surgem conforme a pessoa rola. Um
chat lateral abre e mostra um diff que pode ser inspecionado.

Título: “Mais agentes. Um fluxo que você acompanha.”
Texto: “O Maestro divide a tarefa por perfis, acompanha os critérios de pronto e
entrega em PR. Você configura limites e decide quando precisa intervir.”

Motion: os cartões da Mesa entram em cascata curta; fios ligam Maestro e
subagentes; o trabalho percorre os estados existentes, sem inventar uma etapa
de revisão ou PR como estado nativo. O gasto cresce até um teto ilustrativo
identificado como exemplo. A animação deixa claro que rodadas, tempo, tokens,
custo e teto diário são configuráveis.

### 3. Agentes: cada conversa tem contexto

Foco no chat lateral: escolha de agente, perfil e worktree; mensagens e
ferramentas aparecem; o diff entra ao lado e pode ser aplicado ou descartado.
Mostrar Claude, Codex, Gemini e uma opção local com indicação visual honesta de
provedores distintos.

Título: “Converse com cada agente. Revise o que mudou.”
Texto: “Acompanhe sessões, abra logs, pause ou retome agentes e veja as
alterações antes de trazê-las para sua pasta.”

Motion: a tela se abre em painéis no espaço, mas mantém texto e controles em
uma camada plana legível. O diff é a transição entre conversa e resultado, não
uma sequência de cards decorativos.

### 4. Seu contexto continua junto

O diff se transforma em conexões no grafo do Vault: notas Markdown, backlinks,
tags e busca. Alguns nós se agrupam e viram resultados de uma busca semântica.
Depois, as conexões atravessam o editor para mostrar que o Vault também serve de
contexto aos agentes.

Título: “Memória de projeto que seus agentes podem consultar.”
Texto: “Use seu Vault no formato Obsidian, com grafo, backlinks, tags, sync por
Git e busca semântica opcional.”

Motion: linhas do grafo crescem a partir de uma nota aberta; zoom controlado e
conexões destacam relações sem transformar o fundo em uma rede abstrata sem
conteúdo.

### 5. Ferramentas do trabalho, na mesma IDE

Uma travessia lateral conecta superfícies reais em cinco paradas, agrupadas em
três blocos para evitar uma lista interminável:

1. **GitHub:** conta inteira, Meus PRs, Revisão pedida, Issues, Actions e
   notificações.
2. **Infraestrutura:** hosts SSH com políticas para agentes, VPS e domínios
   Hostinger, projetos Lovable e e-mail IMAP.
3. **Extensibilidade:** extensões do Open VSX e servidores MCP.

Título: “Seu fluxo de desenvolvimento, conectado.”
Texto: “Acesse as ferramentas que já fazem parte do seu trabalho sem perder o
contexto dos agentes.”

Motion: a câmera viaja por uma linha contínua de estações, e cada parada abre a
interface verdadeira correspondente. Usar nomes e telas reais. Não simular
integrações mais profundas do que as implementadas.

### 6. Controle remoto e cyber café

Um telefone entra no palco e mostra a PWA real: conversa, tarefas, agentes e
café. Um toque resolve uma decisão pendente usando o rótulo real da interface.
O celular então revela que o cyber café também pode ser visto remotamente.

Título: “Acompanhe e decida, mesmo longe do computador.”
Texto: “Pareie seu celular para conversar com os agentes, acompanhar tarefas e
responder decisões pendentes.”

O café aparece em uma vinheta própria, na paleta original e sempre em escala
inteira, com agentes, miniaturas nos monitores e suas animações de estado. Uma
breve volta à visão geral conecta esse espaço lúdico à Mesa onde o trabalho real
é acompanhado.

### 7. Fechamento: voltar ao café

A câmera sai de uma tela da IDE e volta ao monitor no café. É noite; um agente
está ocioso com o gato no colo. O `>_` conclui a montagem do logo FaKL-Code.

Texto: “Seus agentes. Seu café.”
Complemento: “Para Windows e macOS.”
CTA final: “Baixar FaKL-Code”. Incluir também o CTA “Assistir ao filme” se a
pessoa ainda não o tiver aberto.

## Linguagem de movimento

- Construir uma única travessia narrativa que liga café, monitor e IDE; cada
  seção altera o que a câmera revela, em vez de entrar com o mesmo fade e slide.
- Usar scroll como trilho de uma sequência com começo, aceleração, pousos
  curtos nas demonstrações e volta ao café. A rolagem normal continua previsível
  e permite pular para qualquer seção pela navegação.
- Reservar os impactos de maior escala para a digitação do prompt, a travessia
  do monitor, o desdobramento do Maestro, a linha de integrações e o retorno
  final. Microinterações menores respondem a hover, foco e clique.
- Combinar tipografia cinética, whip pans breves, paralaxe em camadas, planos de
  UI inclinados e wipes em grade de pixels. Cada efeito precisa explicar uma
  mudança de contexto ou uma relação do produto.
- Não usar rotação 3D constante, cursor falso que atrapalha, sons automáticos ou
  animação sem relação com o scroll/ação. A trilha do filme pode ser iniciada
  pelo usuário; a página não toca áudio automaticamente.
- Com `prefers-reduced-motion`, trocar a câmera e os deslocamentos por cortes
  curtos ou estados estáticos equivalentes, mantendo todas as informações e
  controles acessíveis.

## Comportamento e qualidade

- Desktop: composição cinematográfica de largura total, com um palco de motion
  dominante e conteúdo de leitura alinhado a uma coluna estável.
- Mobile: reordenar a sequência em blocos verticais; remover pinning e
  travelling horizontal obrigatório; manter demonstrações em proporção útil,
  com controles acessíveis e sem texto microscópico.
- Todas as telas devem vir da IDE/PWA reais ou de recriações fiéis baseadas no
  código e em dados demonstrativos. Dados pessoais, hosts, endereços e nomes de
  repositórios precisam ser fictícios.
- Capturas e vídeo devem carregar progressivamente. Oferecer pôster imediato,
  pausar trabalho fora da tela e evitar que animação bloqueie o CTA ou a
  navegação. O scroll deve continuar responsivo em máquinas sem GPU dedicada.
- Garantir navegação por teclado, foco visível, contraste WCAG AA e conteúdo
  semântico fora do canvas. Não colocar o único texto explicativo dentro de
  imagens, vídeo ou animações.
- Não usar gradiente roxo-azul de IA, bokeh, fotos de banco, interfaces falsas,
  cores do café nos painéis da IDE ou logo redesenhado. Sem claims de produto
  para navegador ou inglês.

## Critérios de aprovação do design

1. Em cinco segundos, a pessoa entende que a FaKL-Code IDE reúne agentes
   paralelos e torna o trabalho visível.
2. O percurso comunica tanto a operação principal (agentes, worktrees, Maestro,
   Mesa e diff) quanto o ecossistema de apoio (Vault, GitHub, SSH, Hostinger,
   Lovable, IMAP, extensões/MCP, celular e café).
3. A interface mostrada corresponde ao produto existente; exemplos e estados
   inventados são identificados como grafismo demonstrativo.
4. O movimento parece uma continuação do filme de lançamento e da identidade
   Terminal, e permanece navegável, legível e útil sem motion.
5. A proposta funciona em mobile, teclado e preferência por movimento reduzido.

## Referências consultadas

- [MotionSites](https://motionsites.ai/): biblioteca de conceitos de landing
  pages, seções hero, experiências 3D e fundos animados. Referência para
  intensidade e apresentação visual; não copiar prompts ou composições prontas.
- [Awwwards — Scroll animations from iN](https://www.awwwards.com/inspiration/scroll-animations-in/):
  exemplos de transições e narrativa de página ligados à rolagem.
- [Awwwards — Aerleum](https://www.awwwards.com/inspiration/page-scroll-aerleum/):
  referência de fluidez de página e revelação tipográfica.
- [Awwwards — coleção Web & Interactive](https://www.awwwards.com/websites/web-interactive/):
  repertório de experiências interativas e uso de transições para apoiar uma
  narrativa.
