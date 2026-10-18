# 0042. Varredura estática de skills, agentes e MCPs antes de instalar

- Status: aceita
- Data: 2026-10-18
- Requisitos: RNF-08, RF-103

## Contexto

As fontes de recursos (repositórios git ou pastas com `agents/`, `skills/` e `mcps.json`) são
conteúdo de terceiros que vira instrução para um agente com acesso a arquivos, terminal e
rede. Até aqui a IDE instalava o que o usuário escolhia, sem nenhuma checagem. Pesquisa
externa recente (Snyk, maio de 2026) relatou falha em 36,8% de 3.984 skills analisadas e 76
maliciosas confirmadas, 91% delas por prompt injection, e o OWASP mantém um Agentic Skills
Top 10. Não medimos nada disso por conta própria; usamos os números só como motivação.

## Decisão

- O Core ganha uma varredura estática heurística (`packages/core/src/security/resource-scan.ts`,
  módulo puro): `scanResource({ tipo, nome, arquivos })` devolve achados
  `{ regra, severidade: 'alta' | 'media' | 'baixa', arquivo, linha, trecho }`.
- Regras: frases de prompt injection (português e inglês), caracteres Unicode invisíveis ou
  que mudam a direção do texto, blobs base64 longos, baixar e executar (`curl | sh`,
  `iwr | iex`), `eval` e `Invoke-Expression`, endereços que recebem dados (webhook, pastebin,
  túneis), pedido de ler segredos (`.env`, `~/.ssh`, `.aws`), desligar confirmações
  (`--dangerously-skip-permissions`) e, para MCP, servidor stdio que roda shell, `npx`/`uvx`
  sem versão fixa e servidor http em túnel, IP ou http puro.
- `resources.catalog` e `mcps.catalog` devolvem `riscos` de cada item, calculados ao listar,
  com cache em memória por hash do conteúdo. `resources.install` e `mcps.install` não são
  bloqueados e devolvem os achados no resultado.
- Na extensão `fakl-core`, a lista de instalação marca o item com ícone de aviso e resumo no
  tooltip. Achado de severidade alta ou média pede confirmação modal com os achados e a
  origem (fonte e URL ou pasta): "Instalar mesmo assim" ou cancelar, e cancelar não instala
  nada da seleção. Achado baixo só aparece no tooltip.
- Tudo é local: nenhum conteúdo nem achado sai da máquina.

## Consequências

- O usuário vê, antes de instalar, o que há de mais comum em skills maliciosas. Não é um
  veredito: heurística erra nos dois sentidos. Item sem achado não é "seguro"; item com
  achado pode ser legítimo (uma skill que documenta `curl | sh` de um instalador oficial
  aparece como alta).
- A varredura vê texto. Não executa nada, não segue links, não lê o que o pacote do `npx`
  faria e não pega ofuscação que as regras não conheçam. Binários e arquivos acima de 256 KB
  ficam de fora.
- Itens já instalados não são varridos de novo ao listar a biblioteca; só o catálogo e o
  resultado da instalação trazem os achados.
- A severidade de cada regra é uma escolha editorial (por exemplo, `npx` sem versão é só
  baixa, porque quase todo MCP da comunidade é assim) e pode mudar com a experiência de uso.

## Alternativas consideradas

- **Bloquear a instalação com achado alto:** tira do usuário a decisão e pune falso positivo;
  a confirmação dá o mesmo freio sem impedir quem sabe o que faz.
- **Serviço externo de análise ou LLM como juiz:** enviaria o conteúdo para fora, e o juiz
  também é alvo de prompt injection.
- **Lista de fontes confiáveis:** não escala e dá falsa sensação de segurança; um repositório
  bom pode ser comprometido.
