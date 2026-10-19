# O que a IDE consulta na rede

A FaKL-Code não tem telemetria: nenhum código nosso envia uso, erros ou estatísticas
a servidor algum, e não existe servidor da FaKL-Code nesse caminho. Isso não quer dizer
que a IDE nunca fale com a rede. Esta página lista, a partir da leitura do código, o que
ela consulta, para onde, quando, o que vai e como desligar. Decisão registrada na
[ADR 0045](adr/0045-inventario-de-rede-e-interruptor-das-consultas-automaticas.md).

Toda requisição de rede mostra o endereço de IP ao servidor que a recebe; a coluna
"O que vai" descreve o conteúdo, não esse efeito.

## Consultas automáticas da FaKL-Code e do editor

São as que acontecem sozinhas, sem você pedir. O interruptor único da FaKL-Code é a
configuração **`fakl.rede.consultasAutomaticas`** (padrão: ligada). Desligada, as duas
primeiras linhas da tabela deixam de acontecer; a verificação por comando (**FaKL:
Conferir as versões dos conectores** e **FaKL: Procurar atualização da FaKL-Code**)
continua funcionando. As duas últimas linhas são do editor e têm os próprios controles.

| O que                                            | Para onde                                                                    | Quando                                                                                                                                                 | O que vai                                                                      | Como desligar                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Última versão dos adaptadores e CLIs dos agentes | `registry.npmjs.org/<pacote>/latest`                                         | Ao abrir a lista de provedores ou o Doctor, inclusive o que abre sozinho (uma vez por sessão) quando um agente falha ao iniciar. Resposta guardada 1 h | Só o nome do pacote, na URL, e `accept: application/json`; tempo limite de 3 s | `fakl.rede.consultasAutomaticas` ou `fakl.providers.checkUpdates`             |
| Aviso de versão nova da IDE (só no macOS)        | `raw.githubusercontent.com/FaKL-Code/FaKL-Code-IDE/atualizacoes/latest.json` | 1 minuto depois de abrir e a cada 12 horas                                                                                                             | Um GET sem corpo; nada seu                                                     | `fakl.rede.consultasAutomaticas`, `fakl.update.notify` ou `update.mode: none` |
| Atualizador do editor (herdado do VSCodium)      | O mesmo `latest.json` da branch `atualizacoes` e o instalador na release     | Conforme `update.mode` do editor                                                                                                                       | O pedido do atualizador do VS Code (versão, plataforma e arquitetura, na URL)  | `update.mode: none` (o interruptor da FaKL-Code não cobre este)               |
| Galeria de extensões (herdado do VSCodium)       | Open VSX (`open-vsx.org`)                                                    | Ao buscar, instalar ou atualizar extensões; o editor também confere atualizações das instaladas, conforme as configurações `extensions.*`              | O que o editor envia à galeria; não foi medido aqui                            | `extensions.autoCheckUpdates` e `extensions.autoUpdate` do editor             |

Os dois últimos itens são do editor, não de código da FaKL-Code. O que a FaKL-Code sabe
sobre eles é o que está em `branding/product.json` e em `build/check-branding.sh`
(`updateUrl` na branch `atualizacoes`, galeria no Open VSX).

## Automáticas, mas só se você configurou o serviço

Não acontecem em uma instalação nova: dependem de você ter ligado ou informado o serviço.

| O que                          | Para onde                                                                                              | Quando                                                                                                                | O que vai                                                                                                         | Como desligar                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Sincronização do vault         | O remoto `origin` do repositório do vault (git)                                                        | Ao abrir o vault, a cada 5 minutos (puxar) e a cada 2 minutos se há mudanças (enviar)                                 | Os commits do vault (as suas notas)                                                                               | `sincronizar: false` em `vault:` ou remover o `origin`              |
| Sincronização de configurações | `api.github.com` e o repositório que você indicou (git)                                                | A cada `fakl.sync.intervalMinutes` (5) e 30 s depois de mudar configurações; só com `fakl.sync.repository` preenchido | As configurações escolhidas para sincronizar, no seu repositório                                                  | **FaKL: Desligar sincronização** ou esvaziar `fakl.sync.repository` |
| Painéis do GitHub              | `api.github.com`; imagens de `avatars.githubusercontent.com` e `raw.githubusercontent.com` nos painéis | A cada 90 s, só com o login do GitHub feito, painel visível e janela em foco                                          | O token do GitHub (cabeçalho) e os pedidos de issues, PRs e notificações                                          | Sair da conta do GitHub ou fechar os painéis                        |
| Clones das fontes de recursos  | Os repositórios git que você cadastrou                                                                 | Ao abrir o Core, só para fonte cadastrada que ainda não tem clone                                                     | O pedido de clone do git                                                                                          | Remover a fonte                                                     |
| Controle remoto pelo relay     | O endereço de `remoto.relay` (o seu servidor)                                                          | Ao abrir a IDE, só com `remoto.ligarAoAbrir: true`; ou ao ligar pelo comando                                          | Mensagens cifradas de ponta a ponta; o relay vê a identidade da máquina e o tamanho das mensagens, não o conteúdo | `ligarAoAbrir: false` ou desligar pelo ícone da barra de status     |
| Notificações push do celular   | O serviço de push do navegador do celular, a partir do **seu relay**                                   | Quando um aparelho pareado ativou as notificações e há uma decisão, permissão ou fim de execução                      | Texto genérico (por exemplo, "uma decisão espera por você"), sem detalhes                                         | Desativar as notificações no aparelho ou revogá-lo                  |

## Disparadas por uma ação sua

Só acontecem quando você pede (comando, botão, mensagem).

| O que                                     | Para onde                                                                                          | O que vai                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Conferir as versões dos conectores**    | `registry.npmjs.org`                                                                               | O nome dos pacotes                                                                                                               |
| **Procurar atualização da FaKL-Code**     | `raw.githubusercontent.com`                                                                        | Um GET sem corpo                                                                                                                 |
| Atualizar um adaptador ou CLI             | Registro do npm, pelo `npm install -g` que a IDE digita no terminal                                | O que o `npm` envia; o comando vai sem Enter, para você conferir e rodar                                                         |
| Testar o relay (`remote.test`)            | O seu relay                                                                                        | Uma conexão e, se houver, a chave do relay                                                                                       |
| Login no GitHub                           | `github.com` (fluxo de dispositivo) e `api.github.com`                                             | O client id da aplicação e o código do dispositivo                                                                               |
| Enviar o resultado de uma tarefa          | `origin` (`git push`), nos modos que publicam o branch ou o PR e nos projetos Lovable              | O branch da tarefa                                                                                                               |
| Ações do GitHub, da Hostinger e do e-mail | `api.github.com`, `developers.hostinger.com`, o servidor IMAP que você informou                    | O que a ação precisa: o token do serviço e os dados do pedido                                                                    |
| SSH                                       | O servidor que você escolheu                                                                       | A sessão SSH                                                                                                                     |
| Voz por OpenAI ou Groq                    | `api.openai.com/v1` ou `api.groq.com/openai/v1` (ou o `endpoint` de `voz:`)                        | O áudio gravado e a chave do provedor; nos modos "navegador do celular" e "local" não vai a esses serviços                       |
| Busca semântica do vault (embeddings)     | O servidor de `vault.semantica` (padrão: Ollama ou LM Studio em `127.0.0.1`)                       | Trechos das notas; ficam na máquina se o servidor for local                                                                      |
| Busca semântica por API de embeddings     | O `endpoint` de `vault.semantica` com `provedor: openai` (OpenAI, Voyage, Mistral, Azure ou o seu) | Trechos das notas públicas e as buscas, **fora da máquina**, e a chave da API; só depois de você confirmar o servidor (ADR 0050) |
| Agentes locais (Ollama, LM Studio)        | `127.0.0.1` (ou o `endpoint` do perfil)                                                            | A conversa; ao listar os provedores, o Core também pergunta quais modelos o servidor local tem                                   |
| PWA do celular                            | O seu relay (`vapid.json` e o canal cifrado)                                                       | O mesmo do controle remoto                                                                                                       |

## Busca semântica por API de embeddings (notas saem da máquina)

A busca semântica do vault funciona de dois jeitos. Com um modelo local (Ollama ou LM Studio) o
texto das notas fica na sua máquina. Com o provedor **API compatível com a da OpenAI**
(`provedor: openai` em `vault.semantica`), o conteúdo das notas indexadas **sai da máquina**
para o servidor do `endpoint` e é processado por ele, sob os termos de quem o opera.

- **Desligada por padrão.** Sem `vault.semantica` nada é enviado.
- **Confirmação uma vez, com o domínio.** Antes do primeiro envio a IDE mostra o servidor
  (por exemplo, `api.openai.com`) e uma estimativa de notas, trechos e tokens. Só o "sim" grava
  `confirmadoPara` no `config.yaml`; sem ele, ou se o endpoint mudar de servidor, o Core não faz
  pedido nenhum e a busca fica parada.
- **O que vai:** o título e os trechos (cerca de 800 caracteres) das notas públicas, o texto
  de cada busca e o nome do modelo. Notas privadas (`privado: true`) nunca vão.
- **A chave** da API fica no cofre do sistema (comando **FaKL: Guardar a chave da API de
  embeddings**), nunca em arquivo, e só é enviada ao servidor configurado.
- **Como desligar:** **FaKL: Busca semântica: escolher o provedor de embeddings** e
  "Desligar a busca semântica", ou remover `vault.semantica`. O arquivo de vetores
  (`~/.fakl/data/embeddings.json`) fica na máquina e é descartado quando o provedor, o modelo
  ou o endpoint mudam.

## O que não é da FaKL-Code

- **Os agentes.** Claude, Codex e Gemini são programas dos fabricantes, que a IDE inicia
  com o seu login ou a sua chave. O que eles enviam (prompts, arquivos, telemetria deles)
  é regido pela política de cada fabricante, não por esta página.
- **Servidores MCP.** Os que você instala ou cadastra rodam como processos seus e podem
  acessar a rede como quiserem.
- **Links abertos no navegador.** A IDE só pede ao sistema para abrir o endereço.

## O que esta lista não garante

- Ela vem da leitura do código (busca por `fetch`, `WebSocket`, `net`, `http`, chamadas ao
  git e bibliotecas de rede em `packages`, `extensions` e `apps/remote-pwa`), não de uma
  captura de tráfego de uma sessão real. A captura continua sendo o teste que falta
  (RNF-09 no [SDD](sdd.md)).
- O tráfego do próprio editor (VSCodium) e o das extensões de terceiros que você instalar
  não foram auditados aqui.
- Quem usa um proxy, um relay ou um endpoint próprio muda o destino das linhas
  correspondentes.

Achou uma consulta que não está aqui? Abra uma issue.
