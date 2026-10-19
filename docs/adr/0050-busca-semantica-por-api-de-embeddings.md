# 0050. Busca semântica por API de embeddings compatível com a da OpenAI

- Status: aceita
- Data: 2026-10-18
- Requisitos: RF-407; SDD 10.3

## Contexto

A [ADR 0013](0013-busca-semantica-com-embeddings-locais.md) deixou a busca semântica só com
servidores locais (Ollama e LM Studio) e anotou que uma API remota ficaria para depois, com a
chave no cofre. Quem não tem uma máquina que rode um modelo de embeddings, ou prefere a
qualidade de um modelo hospedado, não tem como usar a busca. O custo de abrir essa porta é
que o texto das notas, que a ADR 0013 mantinha na máquina, passa a sair dela.

## Decisão

- **Provedor `openai`.** `vault.semantica.provedor: openai` fala `POST <endpoint>/embeddings`
  no formato da OpenAI. Serve para OpenAI, Voyage, Mistral, Azure e servidores próprios.
  `endpoint` e `modelo` ficam no `config.yaml`; o `endpoint` é obrigatório neste provedor.
  O pedido leva a chave em `Authorization: Bearer` e em `api-key` (o cabeçalho do Azure), sempre
  só para o servidor configurado, e redirecionamentos são recusados.
- **A chave é um segredo novo: `vault.embeddings`.** O padrão `apikey.<provedor>` existe e
  poderia ser reaproveitado, mas essa chave vai ao ambiente dos agentes daquele provedor
  (ADR 0010), e a de embeddings só pode ir ao endpoint do vault. Misturar as duas faria uma
  chave sair do alcance que a pessoa deu a ela. Como os demais segredos, a IDE a guarda no
  cofre do sistema (SecretStorage) e a entrega ao Core a cada conexão; o Core não a grava, a
  varredura de segredos a conhece e ela nunca entra em arquivo, log, erro ou status. Se o
  servidor repetir a chave no corpo de um erro, ela é trocada por `***` antes de ser mostrada.
- **Desligada por padrão e com confirmação.** Sem `vault.semantica` nada acontece. Com um
  provedor remoto, nada é enviado até a pessoa confirmar, com o domínio do servidor e uma
  estimativa de custo na tela (notas, trechos e tokens aproximados, a 4 caracteres por
  token). A confirmação fica em `vault.semantica.confirmadoPara` (host e porta) e vale só
  para aquele servidor: trocar o endpoint pede de novo. Só a IDE confirma (`vault.configureSemantic`
  recusa agentes e aparelhos remotos). Editar o `config.yaml` à mão não pula a pergunta
  porque, sem o campo coerente, o Core não envia nada e o status mostra `aguardaConfirmacao`.
- **Índice por provedor e modelo.** O arquivo de vetores guarda provedor, modelo e endpoint; se
  qualquer um mudar, os vetores são descartados e recalculados, para nunca misturar espaços de
  modelos diferentes.
- **Lote, taxa e cache.** Até 64 trechos por pedido na API remota (16 nos locais). Resposta 429
  espera o `Retry-After` ou recua 1, 2, 4 e 8 s, com até 4 tentativas; depois disso a fila para
  e o status mostra o limite de taxa, e a próxima mudança ou a troca da chave tenta de novo.
  Trechos com o mesmo conteúdo (título incluso) reaproveitam o vetor já calculado, em qualquer
  nota, e o texto não é reenviado.
- **Interface.** Os comandos "Busca semântica: escolher o provedor de embeddings", "Guardar a
  chave da API de embeddings", "Remover a chave da API de embeddings" e "Confirmar o envio das
  notas para a API de embeddings", o menu do vault e um atalho no passo do vault da jornada de
  configuração.
- **Privacidade.** `docs/privacidade.md` lista a chamada, o que vai (trechos das notas
  públicas, que saem da máquina) e como desligar.

## Consequências

- Com a API remota, o texto das notas públicas é processado por um terceiro, sob os termos
  dele; a decisão é da pessoa e fica visível antes do primeiro envio. Notas privadas continuam
  fora do índice e nunca vão a modelo nenhum.
- A pergunta do custo é uma estimativa, não uma cobrança: o preço do modelo é do provedor.
- Os índices de quem já usa Ollama ou LM Studio não mudam e continuam válidos.
- Uma troca de modelo reindexa o vault inteiro, o que na API remota custa tokens de novo.
