# 0045. Inventário de rede e interruptor das consultas automáticas

- Status: aceita
- Data: 2026-10-18
- Requisitos: RNF-09

## Contexto

O `SECURITY.md` diz "sem telemetria" e o RNF-09 diz que o único tráfego de saída é para
serviços que o usuário configurou. A auditoria achou duas consultas que a FaKL-Code faz
sozinha e que não são serviço configurado: a versão mais nova dos adaptadores no
`registry.npmjs.org` (Provedores e Doctor) e o `latest.json` no `raw.githubusercontent.com`
(aviso de versão no macOS). Não são telemetria, já que nada do usuário vai nelas, mas a
afirmação ficava mais curta do que a realidade, e não havia um lugar com a lista completa
nem um jeito de desligar tudo de uma vez.

## Decisão

- **Inventário.** `docs/privacidade.md` lista toda chamada de rede encontrada no código,
  separada em: automáticas da FaKL-Code e do editor; automáticas só depois de o usuário
  configurar o serviço (vault, sincronização de configurações, GitHub, relay); disparadas por
  uma ação do usuário; e o que não é da FaKL-Code (agentes, servidores MCP). Cada linha diz o
  quê, para onde, quando, o que vai e como desligar. O README e o `SECURITY.md` apontam para
  ela.
- **Interruptor único.** A configuração `fakl.rede.consultasAutomaticas` da extensão
  `fakl-core` (booleana, padrão ligada), quando desligada, impede as duas consultas
  automáticas da FaKL-Code: o npm dos adaptadores (lista de provedores e Doctor, inclusive o
  que abre sozinho depois de uma falha de agente) e o aviso de versão do macOS. Ela se soma às
  configurações já existentes (`fakl.providers.checkUpdates`, `fakl.update.notify`): uma
  consulta automática só acontece com o interruptor e a configuração específica ligados.
- **A verificação manual não é barrada.** "Procurar atualização da FaKL-Code"
  (`fakl.update.check`) e o novo comando "Conferir as versões dos conectores"
  (`fakl.rede.verificarAdaptadores`, que abre o Doctor consultando o npm) respondem ao pedido
  do usuário e funcionam com o interruptor desligado.
- **O editor é outro caso.** O atualizador do VS Code e a galeria de extensões (Open VSX) são
  herdados do VSCodium e têm controles próprios (`update.mode`, `extensions.autoCheckUpdates`,
  `extensions.autoUpdate`). O interruptor da FaKL-Code não os altera. O Doctor ganhou um item
  informativo que mostra se as consultas automáticas estão ligadas e lembra que `update.mode` com o valor `none` desliga o atualizador do editor.
- A regra de decisão fica em funções puras (`extensions/fakl-core/src/rede-model.ts`), com
  testes; a leitura das configurações é a única parte que depende do VS Code.

## Consequências

- Com o interruptor desligado, uma instalação sem serviços configurados e com
  `update.mode: none` não faz consulta automática da FaKL-Code nem do atualizador do editor.
  A galeria de extensões segue o que o editor decidir.
- O Core não se protege sozinho: quem o usa sem a extensão (CLI, Core isolado) não passa por
  este interruptor. As duas consultas são pedidas pela extensão; o Core só as executa quando
  recebe `providers.detect` com `atualizacoes`.
- A lista vem da leitura do código, não de uma captura de tráfego. O teste do RNF-09
  ("inspeção de rede numa sessão padrão") continua pendente, e o documento diz isso.
- Uma consulta nova passa a exigir uma linha em `docs/privacidade.md`; quem a adiciona decide
  se ela é automática e, nesse caso, a põe atrás do interruptor.
