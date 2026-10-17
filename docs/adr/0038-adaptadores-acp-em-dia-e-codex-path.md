# 0038. Adaptadores ACP em dia e o CODEX_PATH

- Status: aceita
- Data: 2026-10-17
- Requisitos: RF-103

## Contexto

Usuários relataram que o Codex da IDE oferecia modelos só até o GPT-5.6, enquanto
a extensão oficial no VS Code já mostrava o GPT-6.1. A IDE não filtra nem fixa
lista de modelos: a lista é a resposta do `model/list` do app-server do Codex,
que o `codex-acp` repassa nos `configOptions`. Quem decide o que aparece é o
adaptador instalado e o Codex que ele traz embutido.

Medição numa máquina de desenvolvimento, com o `codex-acp` 2.2.2 (última do npm)
e o Codex 0.160.1 embutido:

- Com login da assinatura, o `session/new` devolveu `gpt-6.1-sol`, `gpt-6-astra`,
  `gpt-6-sol`, `gpt-6-luna` e os três 5.6; o `models_cache.json` gravado pelo
  Codex trazia a mesma lista.
- Com chave de API (inválida, em um `CODEX_HOME` vazio, só para ver o catálogo), a
  lista também começou no `gpt-6.1-sol`. Não foi possível medir uma chave
  válida sem a conta do usuário; a diferença entre assinatura e chave fica sem
  prova.
- As opções de modelo guardadas na sessão em disco só reaplicam a escolha
  anterior (`setOption`); a lista oferecida vem sempre do agente que acabou de
  subir. Não escondem modelos novos.

Então a lista não é cortada pela IDE e, com adaptador atual, mostra o 6.1. O que
sobra como causa provável é adaptador ou Codex desatualizado na máquina de quem
reclamou: a IDE só orienta `npm install -g` na instalação e nunca olhava se havia
versão nova. (Outro achado, fora desta decisão: o `codex-acp` 2.x anuncia o método
de login `api-key`, e a IDE ainda procura `openai-api-key` e `codex-api-key`.)

O `@openai/codex` publicado no npm (0.163.0) também anda à frente do que o
`codex-acp` embute (0.160.1), e o `codex-acp` aceita `CODEX_PATH` para usar outro
Codex.

## Decisão

- A tela de provedores compara a versão do adaptador ACP e a do CLI com a última
  publicada no npm e marca o que está para trás. A consulta é uma só por pacote,
  com tempo limite de 3 s, guardada por uma hora, leva só o nome do pacote na URL
  e se desliga com `fakl.providers.checkUpdates`.
- A ação "Atualizar" roda `npm install -g <pacote>@latest` num terminal, com a
  saída à vista, só depois de uma confirmação. A IDE nunca atualiza sozinha.
- **CODEX_PATH não é definido por padrão.** O `agentEnv` não repassa essa variável
  do ambiente e a IDE não a injeta nos perfis: o `codex-acp` e o app-server do
  Codex conversam por um protocolo que muda entre versões, e um Codex mais novo
  (ou alfa, como o da extensão oficial) que o adaptador não conhece pode quebrar
  a sessão sem aviso. O caminho suportado é manter o adaptador em dia, que traz o
  Codex que ele testou.
- Quem quiser mesmo assim usa o `env` do perfil (que não é filtrado), por exemplo
  `"env": { "CODEX_PATH": "/caminho/do/codex" }`, por conta e risco.

## Consequências

- O usuário vê quando o adaptador ficou para trás e atualiza em um clique, sem
  trocar de ferramenta; a IDE continua sem tocar em nada sem confirmação.
- A consulta ao npm é uma chamada de rede a mais ao abrir a lista de provedores;
  quem não quer desliga na configuração.
- Se o Codex embutido atrasar demais em relação ao CLI, a saída é pedir a versão
  nova do `codex-acp` ao projeto dele, não fixar o CLI por fora.
