# 0029. Memória do projeto ligada no vault

- Status: aceita
- Data: 2026-10-14
- Requisitos: RF-406; SDD 10.1 e 10.4; complementa a ADR 0008

## Contexto

Cada execução de tarefa gravava uma nota em `Agentes/Sessões/` e mais nada.
As notas não apontavam para o projeto, não havia devlog nem linha no diário, e
as decisões tomadas pelos agentes não viravam ADR. No grafo do Obsidian, as
sessões ficavam soltas, e o maestro seguinte não tinha por onde achar o que já
tinha sido decidido.

## Decisão

- **Projeto resolvido pelo repositório:** a pasta é `Projetos/<P>/`, onde `P` é
  a pasta do vault que casa com o nome do repositório, ignorando caixa, acento,
  hífen e espaço (`fakl-code-ide` cai em `Projetos/FaKL-Code-IDE/`). Sem pasta
  que case, `P` é o próprio nome do repositório.
- **Ao fim de cada execução, o Core grava quatro coisas, em fila:**
  - a nota da sessão, com `projeto`, `repo`, `branch` e a tag `projeto/<slug>`
    no frontmatter e links para o projeto, o devlog e o diário;
  - a nota-índice `Projetos/<P>/<P>.md`, criada se faltar com as seções Notas,
    Decisões (ADRs) e Sessões; a sessão entra em "## Sessões" e, se a nota for
    regravada, a linha é trocada em vez de repetida;
  - uma entrada em `Projetos/<P>/Devlog.md`, marcada com o id da execução para
    ser trocada, e não duplicada, quando `run.done` chega de novo;
  - uma linha no diário do dia, com link para a sessão e o projeto.
- **ADRs e aprendizados ficam com o agente:** o prompt do maestro manda ler
  `Projetos/<P>` e `Agentes/Memória` antes de planejar, gravar decisões de
  arquitetura em `Projetos/<P>/ADRs/NNNN-titulo.md` (e em `docs/adr`, se o
  repositório tiver) e registrar preferências do usuário em `Agentes/Memória/`.
  O chat recebe uma versão curta, para caber no limite do prompt.
- **ADR automática a partir das decisões do `ask_human`, não:** essas decisões
  vão para o devlog. Pergunta de rotina não é decisão de arquitetura, e ADR
  gerada por máquina viraria ruído.

## Consequências

- O grafo liga sessão, projeto, devlog e diário, e a busca por
  `tag:projeto/<slug>` acha tudo de um projeto.
- O Core passa a escrever em `Projetos/`, onde o usuário também escreve. A
  inserção mexe só na seção "## Sessões" e na entrada marcada do devlog; o resto
  da nota fica como está.
- A qualidade das ADRs depende do maestro seguir o prompt. Se ele não seguir, o
  devlog ainda guarda o resumo e as decisões de cada execução.
