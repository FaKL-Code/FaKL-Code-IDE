# 0026. Sessão de 5 horas e limite semanal lidos dos registros dos CLIs

- Status: aceita
- Data: 2026-10-13
- Requisitos: RNF-13; SDD 6.2
- Complementa: [0021](0021-contas-claude-em-paralelo.md)

## Contexto

O gasto por provedor (módulo `costs`) mede custo e tokens do dia contra um
teto que o usuário define. Quem usa planos de assinatura é limitado por outra
coisa: uma sessão de 5 horas e um limite semanal, que o custo não mostra. Não
há API pública para consultá-los.

## Decisão

- **Extensão, não Core.** O item `fakl.windows` da barra de status lê os
  registros que os próprios CLIs já gravam e não grava nada. Fica separado do
  gasto por custo, que não muda.
- **Codex: percentual real.** O CLI grava `rate_limits` (`primary` é a janela
  de 5 horas, `secondary` a semanal) com o percentual usado e o instante em
  que zera. Vale o último registro; janela já zerada é descartada.
- **Claude Code: estimativa por tokens.** Cada resposta em
  `<pasta da conta>/projects/**/*.jsonl` traz o uso. Somam-se entrada, saída e
  criação de cache (a leitura de cache quase não pesa na cota), sem repetir
  respostas de arquivos de retomada. A sessão começa na hora cheia da primeira
  mensagem e dura 5 horas; a semana são os últimos 7 dias corridos, porque a
  virada exata depende da conta.
- **Uma linha por conta.** As pastas vêm de `claude.accounts.list` (ADR 0021),
  mais a conta padrão do CLI; a extensão não monta caminhos de `~/.fakl`.
- **Porcentagem só com o teto informado.** O plano não é legível em disco;
  `fakl.limits.claude.sessionTokens` e `weeklyTokens` (um valor para todas as
  contas) ligam a porcentagem. Sem eles, aparecem só os tokens e o tooltip
  marca o valor como estimado.
- **Privacidade.** Só os campos numéricos de uso e o horário são lidos; texto
  de conversa, caminhos e credenciais não são extraídos nem enviados a lugar
  nenhum.

## Consequências

- Provedores sem registro local (Gemini, modelos locais) não têm janelas.
- O formato dos registros é dos CLIs e pode mudar; o leitor ignora linhas que
  não reconhece, e o item some em vez de mostrar valor errado.
