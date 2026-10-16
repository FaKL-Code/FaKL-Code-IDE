# 0013. Busca semântica com embeddings locais

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-407; SDD 10.3

## Contexto

O RF-407 pede uma busca que ache notas pelo sentido, não só pelas palavras.
O SDD admite embeddings locais ou por API. O vault guarda coisas sensíveis de
quem usa, então mandar o texto das notas para fora da máquina pede um motivo
forte, e o índice por texto (ADR 0008) já cobre a busca do dia a dia.

## Decisão

- **Só servidores locais nesta versão:** `vault.semantica` no config.yaml
  aceita `provedor: ollama` ou `lmstudio`, `modelo` (por exemplo,
  `nomic-embed-text`) e um `endpoint` opcional compatível com a rota
  `/embeddings` da OpenAI. Sem a chave, a busca semântica fica desligada.
- **Trechos por nota:** parágrafos juntados até cerca de 800 caracteres, com o
  título na frente de cada trecho. A nota vale a nota do melhor trecho
  (cosseno).
- **Notas privadas nunca vão ao modelo** e saem do índice quando ficam
  privadas.
- **Incremental:** um hash do título e do corpo decide o que recalcular; o
  índice acompanha o observador do vault e a sincronização. Os vetores ficam em
  `~/.fakl/data/embeddings.json` (Float32 em base64) e são descartados quando o
  modelo ou o servidor mudam.
- **Uma fila só, sem paralelismo:** um servidor fora do ar para a fila e mostra
  o erro no status; a próxima mudança no vault tenta de novo.
- **Acesso:** `vault.semanticSearch` na API, a ferramenta MCP
  `vault_semantic_search` para agentes e "Busca semântica no vault" na IDE.

## Consequências

- O texto das notas não sai da máquina, e não há segredo novo para guardar.
- A primeira indexação de um vault grande leva alguns minutos num modelo
  pequeno; a busca por texto continua valendo enquanto isso.
- Um provedor por API (OpenAI e afins) fica para depois: basta um `endpoint`
  com chave no cofre (ADR 0010), se a pessoa quiser.
