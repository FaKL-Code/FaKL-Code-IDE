# 0031. Comandos por voz

- Status: aceita
- Data: 2026-10-15
- Requisitos: RF-303, RNF-10; SDD 5.3

## Contexto

Pedir uma tarefa, uma execução avulsa ou responder a um agente exige digitar,
o que no celular é lento e na IDE interrompe quem está com as mãos em outra
coisa. A ideia é falar o pedido em português, como se falaria com uma pessoa,
e ver ele virar tarefa, execução avulsa ou mensagem para a conversa.

O reconhecimento de fala do navegador (Web Speech API) funciona no celular,
mas não no Electron: o Chromium manda o áudio para um serviço do Google que
exige uma chave embutida só no Chrome, e sem ela o reconhecimento falha. Além
disso, os webviews de extensão do VS Code são iframes aninhados, e nem o
atributo `allow` deles nem o processo principal liberam o microfone; um
`getUserMedia` dentro do chat da IDE é negado antes de chegar ao usuário.

## Decisão

- **Pacote `@fakl/voz`.** Junta o que a IDE e o celular compartilham: o
  ditado em pt-BR (pontuação falada, como "vírgula" e "ponto final"), a
  interpretação determinística do pedido (intenção tarefa, avulsa ou mensagem,
  mais perfil, repositório, critério e "começar agora") e o reconhecedor de
  fala com dois modos: Web Speech API, no celular, e gravação com
  `MediaRecorder` mais transcrição no Core, na IDE.
- **Transcrição no Core.** `voz.transcrever` recebe o áudio em base64 e
  devolve o texto; `voz.status` diz se a transcrição está configurada. O Core
  fala com qualquer API compatível com a rota `/audio/transcriptions` da
  OpenAI: `openai`, `groq` ou um servidor local (speaches, faster-whisper,
  whisper.cpp). A configuração fica em `voz:` no `~/.fakl/config.yaml` e o
  token em `voz.token` no cofre em memória (ADR 0010). O áudio só passa pela
  memória: não é gravado em disco.
- **Remoto.** `voz.transcrever` entra no escopo `comandar` e `voz.status` no
  escopo `ver`, para o celular sem Web Speech API usar o Core.
- **IDE.** Botão de microfone no chat e comando `fakl.voz.falar`, que abre o
  painel "O que você quer?" com a transcrição editável, um cartão com o que foi
  entendido e a confirmação antes de enviar.
- **Celular.** Microfone nos campos de texto e a folha "Falar pedido", com a
  mesma confirmação.
- **Nada sai só pela fala.** Todo pedido falado passa por uma confirmação
  explícita antes de virar tarefa, execução ou mensagem.
- **Patch `fakl-microfone-webview.patch`.** Libera o microfone nos webviews de
  extensão, e só ele: acrescenta `microphone` ao `allow` do iframe externo
  (`webviewElement.ts`) e do interno (`pre/index.html`, com o hash do script
  na CSP recalculado) e, no processo principal (`app.ts`), aceita a permissão
  `media` vinda de `vscode-webview://` apenas quando o pedido é só de áudio
  (`mediaTypes` contendo só `audio` no pedido, `mediaType` igual a `audio` na
  verificação). Câmera, tela e as demais permissões continuam negadas. É uma
  área nova de patch no SDD 5.3.

## Consequências

- Na IDE, a voz depende de a transcrição estar configurada no Core; sem ela, o
  microfone mostra o motivo que vem em `voz.status` em vez de gravar.
- Com `openai` ou `groq`, o áudio sai da máquina para o provedor escolhido.
  Quem não quer isso usa um servidor local.
- Qualquer webview de extensão passa a poder pedir o microfone. O risco é o
  mesmo de uma extensão instalada, que já roda com acesso ao sistema; câmera e
  captura de tela continuam bloqueadas. No macOS, o sistema ainda pede a
  permissão de microfone para o aplicativo na primeira vez.
- O patch mexe no hash da CSP de `pre/index.html`. Qualquer mudança futura no
  script desse arquivo, nossa ou do upstream, exige recalcular o hash; se o
  patch quebrar numa atualização do VS Code, o `upstream.yml` abre a issue.
- A interpretação determinística só entende frases dentro do vocabulário
  previsto. Sem indicação, a fala vira mensagem se há conversa aberta, senão
  execução avulsa; com confiança baixa, a confirmação pede para escolher a
  intenção.

## Alternativas consideradas

- **Web Speech API também no Electron.** Não funciona: o serviço de
  reconhecimento do Chromium exige a chave do Google que só o Chrome tem.
- **Extensão VS Code Speech, da Microsoft.** É proprietária e não está
  disponível no VSCodium nem no Open VSX.
- **Gravar o áudio no Core com ffmpeg.** Traria uma dependência externa por
  sistema operacional, e o Core não tem acesso direto ao microfone; gravar no
  webview e mandar o áudio é mais simples.
- **Interpretar o pedido com um LLM.** Entende frases mais soltas, mas custa
  tokens e adiciona segundos de latência a cada pedido. Fica para depois, por
  cima da interpretação determinística.
- **Ditado do Windows (Win+H).** Funciona em qualquer campo de texto sem nada
  nosso, mas só no Windows e sem a interpretação nem a confirmação. Continua
  disponível como plano B.
