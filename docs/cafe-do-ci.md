# Café do CI

A cozinha do CI mostra as execuções do GitHub Actions dos repositórios que você acompanha: uma
bancada por execução, com um cozinheiro, e uma xícara por job. Ela tem tela própria (e o café
tem um botão que a abre). Decisões na [ADR 0051](adr/0051-cafe-do-ci.md) e na
[ADR 0053](adr/0053-cozinha-do-ci-em-tela-propria.md); o café em si está no [SDD](sdd.md), seção 13.

## Como ligar

1. Entre na conta do GitHub (o mesmo login dos painéis do GitHub).
2. Abra uma pasta que tenha o GitHub como `origin`, ou rode **FaKL: Acompanhar o CI de um
   repositório** e marque até 5 repositórios (a lista da conta ou `dono/nome` digitado). A
   escolha fica na configuração `fakl.ci.repositorios`.
3. Abra a cozinha (**FaKL: Abrir a cozinha do CI**, o botão **Cozinha do CI** do café ou o
   item do CI na barra de status). Ela pode ir para outra janela, em outro monitor (**FaKL:
   Cozinha do CI em outra janela**). Na aba Café do app do celular ela aparece abaixo da sala.

O repositório da pasta aberta conta entre os 5. Passou do limite, a IDE avisa quais ficaram de
fora.

## O que cada estado mostra

| Execução ou job      | Na bancada                                             |
| -------------------- | ------------------------------------------------------ |
| Em andamento         | Cozinheiro mexendo a colher, vapor, xícara enchendo    |
| Sucesso              | Cozinheiro comemora, sino toca, xícara servida         |
| Falha                | Mãos na cabeça, luz de alarme e fumaça, xícara rachada |
| Aguardando aprovação | Senhas na fila, xícara com a senha                     |
| Na fila              | Cozinheiro parado, xícaras vazias                      |
| Cancelada            | Bancada vazia, avental no gancho                       |

No alto da cozinha o placar mostra, da esquerda para a direita, os builds verdes seguidos, os
fluxos falhando e as execuções em andamento. "Builds verdes seguidos" conta as execuções
terminadas com sucesso, da mais nova para trás, até a primeira falha; cancelada não quebra a
série. Vale para as últimas 10 execuções de cada repositório, não para a história toda. Um
fluxo conta como falhando quando a execução mais recente dele, no mesmo branch, terminou em
falha.

Abaixo do canvas, um cartão por execução traz o nome do workflow, o repositório e o branch, a
duração e os jobs. Clicar na bancada ou no cartão abre a execução no painel de Actions da IDE
(ou no navegador, sem login); no celular, abre o GitHub no navegador do aparelho. A barra de
status da IDE mostra o número de fluxos falhando; clicar abre o café.

## A tela

De cima para baixo: o placar (verdes seguidos, fluxos falhando, rodando agora e os repositórios
acompanhados), a cozinha em pixel art ampliada para a largura da tela e os cartões em três grupos:
**Precisa de atenção** (falha e aguardando aprovação), **Rodando** e **Concluídas**. Cada cartão traz
o nome do workflow, o repositório e o branch, a duração, há quanto tempo terminou e os jobs.

## Tirar o que já passou

Como o agente que termina e sai do café, e como o **Limpar encerrados** da Mesa:

- **x no cartão** tira aquela execução da tela. Ela volta sozinha se o estado dela mudar (alguém
  reexecuta, uma falha passa a verde).
- **Limpar concluídas** tira de uma vez tudo o que já terminou (sucesso, falha e cancelada). O
  que está em andamento, na fila ou esperando aprovação fica.
- **Mostrar as removidas** traz tudo de volta.
- Execuções com **sucesso ou canceladas saem sozinhas** depois de 60 minutos
  (`fakl.ci.concluidasSaemApos`, em minutos; `0` desliga). **Falha não sai sozinha**: ela pede
  atenção, então fica até você tirar ou até chegar uma execução mais nova do mesmo fluxo.

O que foi tirado fica só na tela da cozinha (e some ao fechar a IDE por completo); o GitHub e o
Core não são avisados, e os placares (builds verdes seguidos, fluxos falhando) continuam contando
tudo o que o Core leu.

## Quando a IDE consulta o GitHub

- Só com a conta do GitHub conectada e repositórios escolhidos.
- Sozinha, só com `fakl.rede.consultasAutomaticas` ligada. Com ela desligada nada é consultado
  por conta própria; **FaKL: Atualizar o CI agora** consulta uma vez, a pedido.
- Intervalo adaptativo: 15 s com execução em andamento, 45 s por 2 minutos depois de uma
  mudança, 5 minutos ocioso; recua se há erros e espera o limite da API voltar.
- O que vai: o token do GitHub no cabeçalho e o pedido de execuções e jobs do repositório. Os
  dados ficam só na memória do Core.

Detalhes e a linha no inventário geral: [privacidade.md](privacidade.md).

## O que NÃO faz

- **Não dispara, cancela nem reexecuta workflow.** É só leitura. Reexecutar e ver o log de um
  job continuam no painel de Actions da IDE.
- Não lê logs, não escreve em repositório e não cria webhook.
- O celular só vê: o método que escolhe os repositórios (`ci.watch.set`) não é liberado a
  nenhum escopo do controle remoto; `ci.status` entra em `ver`.
- Não acompanha mais de 5 repositórios, nem Actions de GitHub Enterprise Server.

## Acessibilidade

As execuções entram numa lista escondida (Enter ou Espaço abre a execução) e os resultados
(passou, falhou, esperando aprovação) são anunciados na mesma região `aria-live` do café,
agrupados numa frase a cada 5 segundos no máximo; "começou" e "entrou na fila" não são
anunciados. Com `prefers-reduced-motion` a bancada fica parada. Veja
[acessibilidade.md](acessibilidade.md).
