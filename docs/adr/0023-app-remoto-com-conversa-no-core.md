# 0023. App remoto refeito, com a conversa montada no Core

- Status: aceita
- Data: 2026-10-13
- Requisitos: RF-301 a RF-303, RNF-08, RNF-13; SDD 12.4

## Contexto

O app do celular (ADR 0009) não servia para o dia a dia. A lista misturava
agentes encerrados com os que estavam rodando, porque o Core nunca tira uma
sessão do `agents.list` e o app não olhava o estado. A saída aparecia como
texto cru, sem markdown. O uso e os tetos do dia não apareciam. O que você
mandava ao agente, pela IDE ou pelo celular, não virava evento, e o celular
nunca mostrava a pergunta, só a resposta. O app pedia 5.000 eventos de
`events.replay` para montar um log; o relay derruba quadros acima de 1 MB e
isso derrubava o canal. E cada evento redesenhava a tela inteira, apagando o
que você estava digitando.

## Decisão

- **Conversa no Core.** A `Transcript` sai da extensão para o pacote
  `@fakl/conversa`, junto com o markdown, o realce de sintaxe e a formatação
  de uso, e passa a ser usada pelo Core, pelo chat da IDE e pelo celular. O
  Core monta a conversa de cada sessão a partir dos eventos e a entrega em
  `agents.transcript` (os últimos itens, até caberem num quadro do relay), com
  o id do último evento aplicado para o cliente não contar duas vezes o que
  chega ao vivo enquanto carrega.
- **`agent.prompt`.** `agents.send` publica o texto enviado, com `exibir` no
  lugar dele quando a IDE anexa respostas de outros agentes. A IDE deixa de
  pôr a mensagem na conversa sozinha e passa a esperar o evento, como o
  celular; mensagens do maestro aos subagentes também aparecem.
- **Sessão com horários e prévia.** `AgentSessionInfo` ganha `iniciadaEm`,
  `atividadeEm`, `encerradaEm`, `taskId` e `ultimaFala`. O uso ganha a janela
  de contexto (`context`) que o ACP informa em `usage_update`.
- **Limite do quadro.** O gateway troca uma resposta grande demais por um erro
  JSON-RPC, em vez de deixar o relay fechar o canal.
- **App novo.** Abas Agentes, Tarefas, Caixa, Café e Uso. Agentes separa quem
  espera você, os vivos e os encerrados (recolhidos). A conversa mostra
  markdown com realce, ferramentas, pensamentos recolhidos, pedidos de
  permissão com botões, anel de contexto e um compositor que não perde o
  rascunho. Uso mostra o gasto do dia contra o teto de cada provedor e o
  contexto de cada agente. Dá para abrir uma conversa nova (`agents.start`
  entra no escopo `comandar`), trocar modo e modelo. As telas se atualizam no
  lugar e só refazem o que mudou.

## Consequências

- O celular abre qualquer conversa, até as iniciadas antes de ele conectar,
  com um pedido pequeno.
- `agents.transcript` é um só para as sessões vivas e as guardadas em disco
  (ADR 0022): a sessão viva responde da conversa em memória; a guardada é
  remontada do diário com `Transcript.replay` e, ao ser retomada, continua de
  onde parou. A IDE reidrata as conversas com os mesmos itens.
- O Core guarda até 2.000 itens por sessão em memória, com falas cortadas em
  100 mil caracteres; a retenção das encerradas é a do ADR 0022.
- `agents.start` pelo celular dá o mesmo poder que `tasks.create` já dava:
  abrir agentes em qualquer pasta da máquina. Do celular, ele ignora
  `systemPrompt` e `remotas`.
- A prévia `pnpm --filter @fakl/remote-pwa preview` monta o app com uma IDE de
  mentira, para ver e fotografar as telas sem relay nem Core.

## Alternativas consideradas

- **Remontar a conversa no celular com `events.replay`.** Pesado (cada pedaço
  de texto é um evento), limitado ao histórico do barramento e sujeito ao
  limite de 1 MB do relay.
- **Tirar as sessões encerradas do `agents.list` no Core.** A IDE e as
  execuções ainda usam essas sessões (diff, branch, árvore da tarefa); separar
  na interface resolve sem perder nada.
