---
tipo: adr
status: aceita
data: 2026-10-15
projeto: '[[FaKL-Code-IDE]]'
---

# 0033. Retomada de tarefas após limite de sessão

## Contexto

As sessões avulsas tinham diário persistente, mas as sessões ligadas a tarefas eram excluídas. Um limite do provedor podia aparecer como mensagem ou erro de uma vez ACP e ser interpretado como término de trabalho. A troca de conta reabria a sessão sem enviar continuação, e execuções já marcadas como falha recusavam retomada.

## Decisão

- Guardar também sessões de tarefas no diário do runtime, incluindo vínculo à tarefa, ID ACP, histórico, opções e estado de recuperação. Usar os mecanismos de gravação e proteção de segredos existentes.
- Representar limite de sessão como recuperação temporária, separada da conclusão ou falha definitiva. O runtime publica `agent.recovery`; o orquestrador mantém a execução pausada e não considera a resposta parcial como resultado concluído.
- Retomar a mesma sessão e o mesmo worktree/branch por `agents.resume` e `runs.resume`, restaurando ACP quando disponível e usando o diário como contexto quando não estiver. Reassociar as sessões restauradas às execuções e às ferramentas de seus papéis, mantendo os escopos anteriores.
- Expor retomada imediata e automática opcional no chat e nas tarefas. A opção automática fica desativada inicialmente, persiste com a espera e usa o horário informado pelo provedor. Sem horário confiável, as tentativas têm intervalo de pelo menos cinco minutos.
- Trocar a conta de uma sessão bloqueada continua o trabalho usando o histórico preservado. Uma pausa explícita desliga a retomada automática; parada, cancelamento e encerramento do Core cancelam timers em memória.
- Não contar o tempo de espera do limite como tempo de execução da tarefa.
- Permitir retomar execuções com falha cujo resultado ficou no branch, desde que a tarefa não tenha sido cancelada nem possua outra execução ativa. Para registros antigos sem sessão persistida, criar maestro no branch anterior com resumo e rodadas disponíveis.

## Consequências

A recuperação funciona enquanto o Core está em execução e pode ser rearmada ao abrir a IDE. O estado do provedor continua sendo a autoridade sobre a disponibilidade: outra tentativa pode receber novo bloqueio e aguardar novamente.

O diário local continua sujeito aos limites e à retenção existentes. Conversas de tarefas antigas que nunca foram persistidas não podem ser reconstruídas integralmente; o branch e o resumo disponíveis servem de continuidade.

## Alternativas

- Criar sempre outra execução: perde vínculos, histórico e a visão única da tarefa.
- Repetir continuamente qualquer erro: mistura indisponibilidade temporária com falhas reais e pode gerar custo e duplicação de trabalho.
- Confiar apenas em `session/load`: não cobre agentes sem retomada nativa ou sessão indisponível na conta nova.

Relacionadas: ADRs 0022, 0025 e 0027.
