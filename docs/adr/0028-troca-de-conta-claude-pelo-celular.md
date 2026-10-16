# 0028. Troca de conta do Claude pelo celular

- Status: aceita
- Data: 2026-10-13
- Complementa: [0021](0021-contas-claude-em-paralelo.md), [0023](0023-app-remoto-com-conversa-no-core.md), [0027](0027-troca-de-conta-claude.md) (troca de conta na IDE)

## Contexto

Quem bate o limite de uso de uma assinatura do Claude longe do computador fica
com os agentes parados até voltar. A IDE já troca a conta ativa com um clique;
o celular não tinha como ver as contas nem trocar.

## Decisão

- **Mesma ação da IDE.** O celular chama `claude.accounts.setActive` com
  `aplicarEmAbertos: true`, o método que a IDE usa. Não há método novo: o que
  a troca faz nos agentes abertos (ADR 0027) vale igual para os dois lados.
- **Escopos.** `claude.accounts.list` entra em `ver` e
  `claude.accounts.setActive` em `comandar`. Login, saída e apelidos
  (`prepare`, `logout`, `rename`) ficam fora: o login abre o terminal do CLI na
  IDE e sair apagaria credenciais à distância.
- **Onde aparece.** A aba Uso ganha a seção "Contas do Claude": cada conta com
  e-mail, plano, tokens de hoje e quantos agentes vivos rodam nela, mais a conta
  padrão do Claude Code. Um toque pede confirmação e troca. Conta sem login
  aparece, mas não pode ser escolhida. O menu da conversa de um agente Claude
  leva à mesma escolha.
- **Ao vivo.** O app assina `claude.*`: uma troca feita na IDE, no terminal ou
  noutro celular atualiza a lista e os agentes. A lista só é pedida ao conectar,
  nesses eventos e ao abrir a escolha, porque o Core consulta o CLI de cada
  conta para montá-la.

## Consequências

- Um aparelho com `comandar` troca a conta de todos os agentes Claude da IDE.
- O uso por conta no celular é o do dia, da contabilidade do Core; as janelas de
  5h e semanal (ADR 0022) continuam só na IDE, que lê os arquivos do Claude
  Code.
