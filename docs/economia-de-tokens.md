# Economia de tokens

A FaKL-Code reduz o que os agentes gastam sem pedir nada de você. Vem ligada, no modo
`equilibrado`. A decisão e os números estão na [ADR 0052](adr/0052-modo-economico-de-tokens.md).

## O que ela faz

- **Respostas enxutas.** As respostas das ferramentas `fakl` (vault, GitHub, SSH, Maestro) chegam
  ao agente sem indentação, sem cores de terminal, com linhas repetidas juntadas e com logs muito
  longos cortados no meio (o começo e o fim ficam).
- **Leitura repetida vira aviso.** Se o agente pede de novo, em menos de 45 s, a mesma leitura, ele
  recebe um aviso curto em vez do mesmo texto.
- **Perfil certo para cada tarefa.** Quando o Maestro delega sem escolher o perfil, a IDE classifica
  a tarefa (simples, média, difícil) e manda para o perfil de custo adequado que esteja instalado,
  fora do teto diário e com boa aprovação no placar. A ferramenta `suggest_profile` mostra a
  escolha e o motivo.
- **Pedidos de brevidade.** O Maestro e os executores recebem a orientação de dar instruções
  precisas e relatos curtos.

- **Cache da busca semântica.** A mesma pergunta (sem contar espaços a mais) não é embutida duas
  vezes na sessão; e o trecho de uma nota movida, ou editado e depois desfeito, não volta ao servidor
  de embeddings (a reserva de vetores fica em `~/.fakl/data/embeddings.json`, só com o hash do
  texto). Só importa quando o provedor é uma API paga; com Ollama ou LM Studio economiza tempo. Os
  embeddings evitados aparecem à parte no resumo, porque são tokens de modelo de embeddings, bem mais
  baratos, e não entram na soma de "tokens economizados". Vale com a economia desligada também: é
  cache interno, não muda o que o agente recebe.

## Onde ver

A barra de status mostra `~N tokens economizados hoje`. Clique nela para ver o total desde o
início, quantas respostas foram compactadas, quantas leituras repetidas foram evitadas e quantas
tarefas foram para um perfil mais barato. Os tokens são estimados (4 caracteres por token).

## Trocar o modo

Clique na barra, escolha `Trocar o modo` (ou use `FaKL: Trocar o modo de economia de tokens`), ou
edite `~/.fakl/config.yaml`:

```yaml
economia: agressivo # desligado | equilibrado (padrão) | agressivo
```

| Modo          | O que muda                                                                         |
| ------------- | ---------------------------------------------------------------------------------- |
| `desligado`   | Tudo como antes: respostas sem mudança e sem roteamento por custo.                 |
| `equilibrado` | Compactação, aviso de leitura repetida e roteamento por camada.                    |
| `agressivo`   | Igual ao equilibrado, com corte de texto em 5 mil caracteres e campos vazios fora. |

A troca vale para os agentes que você iniciar depois dela.

## Limites que vale conhecer

- O número é uma estimativa do que saiu das respostas de ferramentas `fakl`. Não inclui o que o
  agente lê ou escreve por conta própria, então a redução na conta total é menor que a das respostas.
- Se algo importante estiver no trecho cortado, o agente é avisado e pode pedir um trecho menor.
- Quem passa `profileId` explícito sempre manda, e o roteamento não mexe nisso.
