# @fakl/voz

Comandos por voz, iguais no chat da IDE e no app do celular: a pessoa fala em
pt-BR e o pedido vira uma tarefa, uma execução avulsa (agente novo) ou uma
mensagem para a conversa aberta. Sem dependências de runtime; só o
`reconhecedor` usa APIs do navegador (injetáveis, então os testes não precisam
de DOM).

- `criarReconhecedor` escuta o microfone: pela Web Speech API (`navegador`) ou
  gravando com `MediaRecorder` e entregando o áudio a `transcrever`
  (`gravacao`, o modo do Electron). `suporteDeVoz` diz o que o ambiente
  oferece; sem nenhum modo, lança `FalhaDeVoz` (`tipo: 'sem-suporte'`).
  `blobParaBase64` prepara o áudio para o método `voz.transcrever` do Core.
- `normalizarDitado` troca a pontuação falada ("vírgula", "ponto final",
  "nova linha", "abre parênteses"...) pelos sinais e acerta espaços e
  maiúsculas. "ponto" sozinho só vira `.` no fim da fala, antes de "final" ou
  antes de quebra de linha. `juntarDitado` emenda trechos ditados em sequência.
- `interpretar` lê a fala sem LLM, ignorando acento e caixa, e devolve o
  `PedidoDeVoz`: intenção, texto limpo, título, perfil, repositório, critério
  de pronto, `comecarAgora`, `worktree` e a `confianca` (abaixo de 0,5 a
  interface deve pedir a escolha da intenção). `descreverPedido` gera a linha
  do cartão de confirmação.
