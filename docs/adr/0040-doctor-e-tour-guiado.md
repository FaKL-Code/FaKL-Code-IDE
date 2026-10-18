# 0040. Doctor e tour guiado

- Status: aceita
- Data: 2026-10-17

## Contexto

Quem acabou de instalar não entende o que a IDE precisa nem o que fazer primeiro.
Relatos de usuários:

- instalam os VSIX do Codex e do Claude Code esperando ver as conversas na Mesa
  (já existe um aviso, ADR 0039);
- acham que precisam de Docker para rodar agentes. Não precisam: o único uso de
  Docker é o relay do controle pelo celular (`packages/relay/README.md`), que é
  opcional e roda no servidor do próprio usuário;
- veem uma lista curta de modelos porque o adaptador ACP está velho (ADR 0038);
- entram no Gemini com a conta Google pessoal e falham. O Google descontinuou esse
  login para agentes de terceiros em jun/2026 (`IneligibleTierError`); só chave de
  API do AI Studio ou Vertex funcionam dentro dos termos;
- não têm Node/npm, que os adaptadores ACP exigem.

A jornada de configuração (`setup.ts`, `setup-model.ts`, o walkthrough `fakl.setup`)
é uma lista de configuração: diz o que ligar, não o que a IDE faz.

### O que a extensão consegue desenhar

A IDE é um fork do VS Code e a `fakl-core` é uma extensão. Uma extensão **não**
desenha sobre a interface nativa (barra lateral, abas, painéis, barra de status):
isso é do workbench, fora da API. O que ela alcança:

- as próprias webviews (Mesa, chat, café, grafo do vault, jornada), onde o HTML é
  nosso e dá para pôr balões ancorados nos elementos;
- walkthroughs nativos (página de boas-vindas), notificações e quick picks;
- comandos que abrem cada superfície.

Por isso um tour de "setas apontando para a barra lateral" não cabe numa extensão.

## Decisão

### Doctor ("FaKL: Doctor")

- Um comando e uma tela que verificam, em linguagem simples, o que falta para os
  agentes rodarem: Node e npm (versão mínima 20, a 18 já saiu de suporte); para
  cada provedor, o programa oficial, o adaptador ACP, o login e se a versão está
  em dia (reaproveita `providers.detect` e a comparação com o npm da ADR 0038);
  Gemini com login `oauth-personal` (explica em uma frase e oferece a chave de API,
  `fakl.providers.setKey`); chave `*_API_KEY` no ambiente que não está no cofre
  (agentes só recebem chaves do cofre da IDE); e, sempre, que **Docker não é
  necessário**.
- As regras são funções puras (`doctor-model.ts`) sobre um retrato da máquina,
  com testes de fixtures sintéticas: nenhuma credencial real e nenhuma leitura de
  `~/.codex/auth.json`. O Core ganhou `providers.environment` (Node, npm e quais
  chaves estão só no ambiente) e `ProviderStatus` ganhou `cliInstalado` e
  `loginTipo`. `loginTipo` vem só do tipo escolhido em `settings.json` do Gemini; o
  conteúdo de `oauth_creds.json` nunca é lido.
- Também testa o servidor MCP `fakl` que o Core injeta nos agentes (`providers.environment`
  devolve o resultado): lança o mesmo comando do Core com um token fictício e um socket
  que não existe, pede `initialize` e `tools/list` por stdio e mostra "ok" ou o motivo
  (comando não encontrado, saída com código X e as últimas linhas do stderr, sem
  resposta). Quando falha, explica que as ferramentas do Maestro não aparecem para o
  agente; a causa provável de uma conversa reaberta na extensão oficial (que relança o
  servidor sem o ambiente do Core) é hipótese, não confirmada.
- Cada item mostra o problema e a ação: um botão (comando da IDE ou link) ou o
  comando exato. **Nada é instalado ou alterado sem confirmação**: comandos de
  instalação, login e atualização vão ao terminal digitados, sem Enter. A página
  não escolhe o que roda; o host só executa a ação que a própria tela ofereceu.
- Um provedor não é obrigatório: faltar um dos três só é problema quando nenhum
  está pronto; com outro pronto vira nota.
- Roda sozinho, uma vez por sessão da IDE, quando um agente falha ao iniciar: se
  achar algo, mostra o erro com o botão "Ver diagnóstico". Sem nada a apontar, não
  diz nada além do erro que já aparecia.

### Tour ("FaKL: Tour")

- **Walkthrough nativo "Conheça a FaKL-Code"** (`fakl.tour`), com um passo para o
  Doctor, um para cada superfície (Mesa, chat, café, vault, GitHub, celular) e um
  para a primeira tarefa. Cada passo abre a superfície por comando, com texto curto
  e uma imagem. O comando `FaKL: Tour` abre o walkthrough.
- **Dicas dentro das nossas webviews**: um ponto que pulsa e um balão curto, uma
  por tela (Mesa, chat, café, vault). A página só desenha (`webview/coach.ts`,
  sem folha de estilo nem `style` inline, para caber na CSP, com `animate()` para
  o pulso e respeitando `prefers-reduced-motion`); o host decide o que mandar. O
  balão tem "Entendi" e "Ocultar todas as dicas"; `FaKL: Mostrar as dicas de novo`
  religa.
- **Primeira tarefa guiada** (`fakl.tour.firstTask`): depois de uma confirmação,
  cria uma pasta de exemplo no armazenamento da extensão, inicia um agente já
  pronto nela com permissão só de leitura, pede que leia e descreva, e abre a Mesa e
  o café. Sem agente pronto, oferece o Doctor.
- **Mesmo modelo e mesma persistência da jornada**: o Doctor e o tour são etapas
  (puláveis) da jornada de configuração, e as dicas vistas ficam no mesmo
  `SetupProgress` do `globalState` (`dicasVistas`, `dicasDesligadas`), não num
  armazenamento à parte. Nada é obrigatório nem abre sozinho sobre quem já usa a
  IDE: o walkthrough aparece na página de boas-vindas e o resto é por comando.

### Overlay sobre a interface nativa: opção registrada, não feita

Apontar para a barra lateral e as abas pediria um **patch no core do VS Code**
(`patches/`, como o `fakl-overlay.patch` do modo minimizado), com uma camada no
workbench que ancora balões em elementos nativos. Fica registrada como opção
futura e **não** entra nesta rodada: o custo é um patch a mais para manter a cada
atualização do upstream, e o walkthrough nativo mais as dicas nas nossas telas já
cobrem a primeira volta. Se for feito, deve reaproveitar o modelo de dicas
(`tour-model.ts`) e a persistência, trocando só quem desenha.

## Consequências

- O que falta fica visível e resolvível em um lugar, com o comando exato; o
  usuário com dúvida sobre Docker, Node ou o login do Gemini tem uma resposta.
- A versão mínima do Node (20) é uma escolha conservadora nossa, não um requisito
  medido de cada adaptador; se um adaptador pedir mais, muda uma constante.
- As dicas dependem de seletores CSS das webviews (`.toolbar`, `textarea`,
  `#novo-agente`, `#filtro`). Mudar esses elementos sem mexer em `tourTips()` faz a
  dica sumir depois de 15 s sem achar o alvo, sem erro; ela volta na próxima
  abertura.
- Um teste confere que o walkthrough do `package.json` tem os mesmos passos e
  comandos do modelo.
- Falha de agente ao iniciar passa a disparar uma consulta ao Core (e ao npm, se
  `fakl.providers.checkUpdates` estiver ligado), uma vez por sessão.

## Alternativas consideradas

- **Overlay por patch no core do VS Code**: descartado nesta rodada (acima).
- **Tour só em webview própria**: duplicaria o que o walkthrough nativo já faz e
  não apareceria na página de boas-vindas.
- **Doctor que instala sozinho**: descartado; nada é instalado ou alterado sem o
  usuário apertar Enter ou confirmar.
- **Aviso fixo na barra de status**: ruído permanente para quem já sabe usar.
