# 0005. FaKL Core iniciado pelo processo principal da IDE

- Status: aceita
- Data: 2026-10-11
- Requisitos: RNF-10; SDD 6.1

## Contexto

O FaKL Core atende extensões, CLI e controle remoto pela API local. Não pode
haver serviço rodando com a IDE fechada, então o Core precisa nascer e morrer
com ela. Uma extensão não serve para isso: o host de extensões é reiniciado ao
recarregar a janela e existe um por janela, e o Core deve ser um só por IDE.

## Decisão

- O patch `patches/fakl-core-start.patch` adiciona
  `src/vs/code/electron-main/faklCore.ts` e o chama no `startup()` do
  `app.ts`, logo depois de criar os serviços. Ele inicia o Core com
  `utilityProcess.fork` e, no `onWillShutdown`, pede o encerramento
  (`{type: 'shutdown'}`); se o Core não sair em 2 s, é morto.
- O código do Core vai na extensão embutida `fakl-core`, como
  `dist/core.mjs` (o `packages/core` empacotado com esbuild). O patch só sabe
  o caminho; o Core evolui sem mexer no patch.
- O processo principal gera um token aleatório a cada abertura e o passa por
  variável de ambiente. O Core a apaga do próprio ambiente e grava
  `~/.fakl/run/core.json` (endereço, token e pid) com permissão só do usuário.
  A extensão `fakl-core` e a CLI leem esse arquivo para se conectar. O Core o
  apaga ao sair.
- A saída do Core vai para o log do processo principal com o prefixo
  `[fakl-core]`.

## Consequências

- O patch é pequeno (um arquivo novo e duas linhas no `app.ts`), o que reduz
  conflito ao atualizar o VSCodium.
- Se a IDE cair sem encerrar o Core, o `core.json` fica para trás; quem lê o
  arquivo trata falha de conexão como Core fora do ar, e o próximo início o
  sobrescreve.
- Reiniciar o Core automaticamente quando ele cai fica para depois; por ora a
  barra de status mostra o estado e reabrir a IDE resolve.
