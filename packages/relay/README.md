# @fakl/relay

Relay do controle remoto (SDD 12.1). É o único pedaço da FaKL-Code que roda
fora das suas máquinas: um container pequeno num servidor seu que

- recebe a conexão de saída do FaKL Core (a IDE nunca abre porta);
- casa cada aparelho pareado com a máquina certa e repassa os bytes, já
  cifrados de ponta a ponta (o relay não tem as chaves);
- serve o app do celular (PWA) e envia as notificações push.

Sem a IDE aberta, o app mostra que a máquina está offline. Cada pessoa
hospeda o seu relay: o projeto não mantém nenhum relay público.

## Instalar numa VPS

Serve qualquer VPS Linux (amd64 ou arm64) com 512 MB de RAM. Nos exemplos, o
domínio é `relay.exemplo.com`; troque pelo seu.

### 1. Docker e domínio

1. Instale o Docker com o plugin Compose
   ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)).
   Confira com `docker compose version`.
2. No painel do seu domínio, crie um registro **A** (e **AAAA**, se a VPS
   tiver IPv6) para `relay.exemplo.com` apontando para o IP da VPS.
3. Libere as portas 80 e 443 no firewall da VPS (o Caddy usa a 80 para tirar
   o certificado).

### 2. Arquivos de configuração

Baixe a pasta [`deploy/`](deploy/) para a VPS, por exemplo em `/opt/fakl-relay`
(`git clone` do repositório e copie a pasta, ou baixe os arquivos um a um).
Depois:

```sh
cd /opt/fakl-relay
cp env.example .env
# chave que o Core precisa apresentar ao relay:
sed -i "s|^FAKL_RELAY_KEY=.*|FAKL_RELAY_KEY=$(openssl rand -base64 32)|" .env
nano .env   # FAKL_RELAY_DOMAIN=relay.exemplo.com e VAPID_SUBJECT=mailto:voce@exemplo.com
```

- `FAKL_RELAY_KEY` impede que outros usem o seu relay. Guarde o valor: ele
  vai na IDE (`grep FAKL_RELAY_KEY .env` mostra de novo).
- As chaves VAPID das notificações push são geradas sozinhas na primeira
  subida e ficam no volume `relay-data`; não há nada a fazer.
- `VAPID_SUBJECT` é o contato que os serviços de push (Apple, Google,
  Mozilla) recebem; use um email seu.

### 3a. Subir com o Caddy (VPS sem outro servidor web)

```sh
docker compose up -d
docker compose logs -f relay   # Ctrl+C para sair
curl https://relay.exemplo.com/saude   # {"ok":true}
```

O Caddy tira o certificado TLS na primeira visita e o renova sozinho.

### 3b. Subir atrás do Traefik (VPS que já usa as portas 80 e 443)

Preencha também `TRAEFIK_NETWORK`, `TRAEFIK_ENTRYPOINT` e
`TRAEFIK_CERTRESOLVER` no `.env` com os nomes que o seu Traefik usa
(`docker network ls` e a configuração dele) e suba com

```sh
docker compose -f docker-compose.traefik.yml up -d
curl https://relay.exemplo.com/saude
```

O certificado vem do resolvedor do Traefik. O relay usa WebSocket; o Traefik
e o Caddy repassam sem configuração extra. Com outro proxy (nginx, por
exemplo), repasse `Upgrade` e `Connection` para `/core` e `/device`.

### 4. Ligar na IDE

1. Ícone de antena na barra de status → **Configurar relay**, com
   `https://relay.exemplo.com` e a `FAKL_RELAY_KEY`. A IDE testa a conexão
   antes de salvar.
2. **Testar conexão com o relay** (no mesmo menu, ou `FaKL: Testar conexão
com o relay`) confere de novo quando quiser: o HTTPS (`/saude`), o
   WebSocket pelo proxy e a chave, sem derrubar a conexão aberta.
3. **Parear aparelho** mostra o QR code. Leia com a câmera do celular, confira
   a impressão e confirme na IDE. No iPhone, instale o app na tela inicial
   (Compartilhar → Adicionar à Tela de Início) para receber notificações.

## Imagem

O workflow [Imagem do relay](../../.github/workflows/relay.yml) publica
`ghcr.io/<dono do repositório>/fakl-relay` para amd64 e arm64:

| Tag              | Quando                                                 |
| ---------------- | ------------------------------------------------------ |
| `latest`, `main` | a cada mudança do relay ou do app do celular na `main` |
| `X.Y.Z`, `X.Y`   | a cada versão da FaKL-Code (a mesma da IDE)            |
| `sha-<commit>`   | sempre, para voltar a uma build exata                  |

Os composes usam `ghcr.io/fakl-code/fakl-relay:latest`. Para fixar a versão da
sua IDE, ou usar a imagem do seu fork, defina `FAKL_RELAY_IMAGE` no `.env`
(`ghcr.io/fakl-code/fakl-relay:0.1.0`, por exemplo).

**Atualizar:** `docker compose pull && docker compose up -d` (com `-f
docker-compose.traefik.yml` no Traefik). Chaves VAPID e certificados ficam nos
volumes.

**Fork:** o workflow publica no registry do dono do fork, sem mudar nada. Na
primeira publicação o pacote nasce privado; em _Packages → fakl-relay →
Package settings_, mude a visibilidade para pública se a VPS for baixar sem
login.

### Gerar a imagem na própria VPS

Sem usar a imagem publicada: baixe o artefato `fakl-relay` de uma execução do
workflow (Actions → Imagem do relay) ou gere o pacote localmente

```sh
pnpm install
pnpm --filter @fakl/remote-pwa... build
pnpm --filter @fakl/relay... build
pnpm --filter @fakl/relay pack:relay   # sai em packages/relay/out/fakl-relay/
```

copie a pasta para a VPS e suba somando `docker-compose.build.yml`:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
# ou, no Traefik:
docker compose -f docker-compose.traefik.yml -f docker-compose.build.yml up -d --build
```

## Segurança

- O Core se autentica com o segredo da máquina (o id é o hash dele) e, se
  definida, com `FAKL_RELAY_KEY`. Sem a chave, qualquer Core poderia usar o
  seu relay para repassar dados (cifrados) dele; o teste de conexão avisa.
- Aparelhos e Core trocam chaves P-256 efêmeras e fixas; as mensagens vão em
  AES-256-GCM (ADR 0009). O relay vê só tamanhos e horários.
- As notificações dizem só "uma decisão espera por você"; o resto aparece
  dentro do app, pelo canal cifrado.

## Desenvolvimento

`createRelay({ server })` monta o relay num `http.Server`; o teste
`test/remote.test.ts` sobe relay, Core e um aparelho de mentira e cobre
pareamento, escopos, revogação, push, máquina offline e o `remote.test` (o
teste de conexão que a IDE e a jornada de configuração usam).
