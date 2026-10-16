---
titulo: Agentes e perfis
descricao: Perfis, worktrees, modos de permissão, contas do Claude e retomada.
ordem: 3
---

## Perfis de agente

Um perfil descreve um agente reutilizável: provedor, modelo, pontos fortes, custo relativo, ferramentas liberadas e regras. Crie e edite perfis pelos comandos **Novo perfil de agente** e **Editar perfil**. O Maestro usa os pontos fortes e o custo de cada perfil para decidir quem faz o quê.

A IDE já traz perfis prontos para Claude Code (Haiku, Sonnet e Opus), Codex e Gemini CLI. Um perfil com comando próprio roda qualquer agente compatível com ACP, e um perfil do adaptador local usa Ollama ou LM Studio.

## Conversar com um agente

Abra o chat com **Abrir chat dos agentes** ou crie um com **Novo agente**. Em cada sessão você pode:

- pausar, retomar e parar o agente;
- abrir o log e um terminal na pasta do agente;
- trocar modelo, raciocínio e outras opções que o agente oferecer;
- ver os arquivos alterados e aplicar ou descartar cada um.

As sessões ficam salvas. Se a IDE fechar no meio do trabalho, a conversa volta inteira, e uma mensagem nova retoma o agente no mesmo worktree.

## Modos de permissão

| Modo              | O que o agente pode fazer sozinho                                 |
| ----------------- | ----------------------------------------------------------------- |
| `perguntar`       | Nada: cada ação espera a sua aprovação                            |
| `aprovar-leitura` | Ler e buscar; editar e rodar comandos ainda perguntam             |
| `aprovar-tudo`    | Tudo, dentro do worktree                                          |
| `autopilot`       | Tudo, e as decisões da execução são respondidas pela opção segura |

No autopilot, o trabalho fica no branch do agente e chega ao `main` por PR. Comandos SSH, ações na Hostinger e envio de segredos sempre esperam você, em qualquer modo. O modo pode mudar com o agente rodando, pelo chat, pelo celular ou por `fakl modo <sessão> <modo>`.

## Contas do Claude em paralelo

A IDE guarda até três contas do Claude, cada uma na sua pasta, sem misturar com o seu `~/.claude`. Entre em cada uma com **Entrar numa conta do Claude** e troque a conta ativa com **Claude: Trocar conta**. Os agentes abertos trocam junto, sem perder a conversa. A barra de status mostra o uso das janelas de 5 horas e da semanal.

## Quando o provedor bate o limite

Se um agente bate o limite de sessão do provedor, a tarefa fica pausada em vez de falhar. Você pode retomar na hora, trocar de conta ou ligar a retomada automática, que espera o horário informado pelo provedor. O tempo de espera não conta no tempo da tarefa.
