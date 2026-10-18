# 0009. Controle remoto por relay, com cifra de ponta a ponta feita na aplicação

- Status: aceita
- Data: 2026-10-12
- Requisitos: RF-301 a RF-306, RNF-08; SDD 12, 14.1

## Contexto

O SDD pede acesso pelo celular enquanto a IDE está aberta, sem abrir porta na
máquina, com um relay no VPS que não enxerga o conteúdo. O navegador do
celular precisa falar o mesmo protocolo que o Core, sem instalar nada.

## Decisão

- **Pacotes:** `@fakl/remote` (protocolo, cripto e cliente, roda no Node e no
  navegador com WebCrypto), `@fakl/relay` (Node com `ws` e `web-push`),
  `apps/remote-pwa` (app do celular) e o `RemoteGateway` no Core.
- **Cripto:** P-256 ECDH, HKDF-SHA256 e AES-256-GCM, o que o WebCrypto tem em
  todos os navegadores atuais. Cada conexão faz três ECDH (efêmera-efêmera,
  fixa-fixa, efêmera do aparelho com a fixa do Core); o transcript entra no
  `info` do HKDF e o código de pareamento no sal. Nonces por contador e
  direção; mensagem fora de ordem derruba o canal.
- **Pareamento:** o QR leva um link `https://relay/#p=...` (o fragmento não vai
  ao servidor) com a chave pública do Core, o id da máquina e um código de uso
  único de 2 minutos. Errar o código três vezes o invalida. A IDE mostra o
  nome e a impressão do aparelho e só grava a chave dele se você confirmar.
- **Chaves:** a chave privada do aparelho é gerada não extraível e fica no
  IndexedDB. A identidade do Core fica em `~/.fakl/remote/identity.json`, só
  do usuário, como uma chave SSH (cifrada em repouso desde o ADR 0044); os
  aparelhos em `devices.json`.
- **Escopos:** `ver`, `decidir`, `comandar` e `editor` viram listas de métodos
  da API do Core; o canal do aparelho entra no mesmo `RpcServer` com essa
  lista, como os tokens dos agentes.
- **Push:** o relay guarda as chaves VAPID e envia; o Core manda só "uma
  decisão espera por você" e semelhantes, nunca o conteúdo.
- **Relay:** o Core se autentica com o segredo da máquina (o id é o hash) e,
  opcionalmente, uma chave do relay. Implantação com Docker Compose e Caddy
  para o TLS; o pacote sai do workflow "Pacote do relay".

## Consequências

- Nenhuma porta aberta nas máquinas; o relay comprometido não lê nem forja
  mensagens, só pode derrubar conexões.
- Sem sigilo de quem conversa com quem diante do relay (ids e horários).
- O editor completo no navegador (RF-304) fica para depois: exige gerar o
  servidor web do Code-OSS no build e expô-lo pelo canal, que hoje carrega
  JSON-RPC. O escopo `editor` já existe para isso.
- A alternativa por Tailscale do SDD não foi feita; o relay cobre o caso.
