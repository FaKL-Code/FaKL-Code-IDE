# Segurança de recursos: a varredura antes de instalar

Skills, agentes e servidores MCP vêm de **fontes de recursos** (repositórios git ou pastas) e
viram instruções para agentes que leem arquivos, rodam comandos e acessam a rede. Por isso a
IDE faz uma varredura estática do que a fonte oferece antes de você instalar. A decisão e os
limites estão na [ADR 0042](adr/0042-varredura-estatica-de-recursos.md).

## O que a varredura faz

- Lê o texto do item: o `.md` do agente, todos os arquivos de texto da pasta da skill
  (incluindo `scripts/`) e a definição do servidor no `mcps.json`. Binários, arquivos acima
  de 256 KB e pastas como `.git` e `node_modules` ficam de fora.
- Procura padrões conhecidos, cada um com uma gravidade:

| Regra                  | O que procura                                                             | Gravidade             |
| ---------------------- | ------------------------------------------------------------------------- | --------------------- |
| `prompt-injection`     | "ignore as instruções anteriores", "do not tell the user" e variações     | alta                  |
| `unicode-invisivel`    | caracteres bidi e de etiqueta (alta); zero-width fora do início (média)   | alta ou média         |
| `base64-longo`         | blob codificado com mais de 200 caracteres (imagem embutida: baixa)       | média                 |
| `baixa-e-executa`      | `curl ... \| sh`, `iwr ... \| iex`                                        | alta                  |
| `executa-texto`        | `Invoke-Expression`, `iex` (média); `eval` (baixa)                        | média ou baixa        |
| `envio-externo`        | webhook, pastebin, túneis (ngrok e afins); com verbo de envio na linha    | alta com envio, média |
| `le-segredos`          | `.env`, `~/.ssh`, `id_rsa`, `.aws`, `.npmrc`; com `curl` na linha (alta)  | alta, média ou baixa  |
| `sem-confirmacao`      | `--dangerously-skip-permissions` (alta), "nunca peça confirmação" (média) | alta ou média         |
| `mcp-shell`            | MCP stdio cujo comando é `sh`, `bash`, `cmd`, `powershell`...             | alta                  |
| `mcp-sem-versao`       | `npx`/`uvx`/`pipx run` sem versão fixa                                    | baixa                 |
| `mcp-dominio-estranho` | MCP http em túnel (alta), IP, `xn--` ou http sem TLS fora de localhost    | alta ou média         |

- Mostra o resultado na lista de instalação: ícone de aviso, resumo na descrição e os
  achados no tooltip do ícone.
- Com achado de gravidade **alta ou média**, pede uma confirmação modal antes de instalar,
  listando os achados e a origem (nome da fonte e URL do repositório ou pasta). "Instalar
  mesmo assim" segue; cancelar não instala nada daquela seleção. Achado **baixo** só aparece
  no tooltip. Itens sem achado instalam como antes.
- Tudo roda no Core, na sua máquina. Nenhum conteúdo nem achado é enviado para fora. O
  resultado fica em cache na memória, por hash do conteúdo.

## O que a varredura NÃO faz

- **Não garante segurança.** Nenhum achado não significa item seguro: a varredura só conhece
  os padrões acima e não pega ofuscação, instruções em imagens, texto escrito de outro jeito
  ou comportamento que só aparece na execução.
- **Não prova má-fé.** Achado é indício; uma skill legítima que documenta um instalador
  `curl | sh` aparece como alta. Leia o item antes de decidir: os arquivos estão na pasta
  da fonte (comando "Abrir a pasta" da fonte).
- Não bloqueia nada: a instalação sempre depende da sua escolha.
- Não executa o item, não segue links, não baixa o que um `npx` ou `uvx` instalaria e não
  analisa o código dos pacotes que um MCP roda.
- Não avalia reputação de domínio: um endereço `https` comum passa; só túneis, IPs e http
  puro são apontados.
- Não revarre o que já está instalado quando você lista a biblioteca, nem as edições que
  você fizer depois.
- `mcps.install` devolve os achados do modelo da fonte; se o servidor já estava instalado,
  a sua versão (que pode ter sido editada) é mantida e não é varrida de novo.

## Ao escrever uma fonte de recursos

Evite o que dispara a varredura sem necessidade: use dependências com versão fixa
(`npx pacote@1.2.3` em vez de `npx pacote`), não peça ao agente para ler `.env` ou chaves e
não documente instaladores com `curl | sh` (aponte para a página oficial). Quem usa sua
fonte verá menos avisos e levará a sério os que restarem.
