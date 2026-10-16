# @fakl/conversa

A conversa com um agente, igual em todo lugar que a mostra: o Core (que a
entrega em `agents.transcript`), o chat e a Mesa da IDE e o app do celular.
Sem DOM e sem Node; só depende de `@fakl/protocol`.

- `Transcript` monta os itens (`ChatItem`) a partir dos eventos `agent.*`
  (`TRANSCRIPT_TOPICS`) e devolve os índices que mudaram, para quem desenha
  refazer só eles.
- `renderMarkdown` e `highlight` geram HTML já escapado para as falas dos
  agentes, com realce leve por família de linguagem.
- `formatTokens`, `formatCost`, `usageRing`, `contextShare` e `lastLine`
  formatam uso, tetos do dia, janela de contexto e a prévia das listas.
