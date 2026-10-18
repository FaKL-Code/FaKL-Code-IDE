# 0044. Identidade do controle remoto cifrada em repouso

- Status: aceita
- Data: 2026-10-18
- Requisitos: RNF-07, RF-301, RF-305

## Contexto

O RNF-07 pede que nenhum segredo fique em texto puro no disco. A auditoria achou uma
exceção: `~/.fakl/remote/identity.json` guardava o `segredo` da máquina no relay e a chave
privada do Core em JSON legível, protegidos só pelo modo 0600. Quem lê o arquivo passa
pela máquina no relay e assume o lugar do Core diante dos aparelhos pareados.

O Core não grava segredos (ADR 0010): a extensão os guarda no SecretStorage da IDE,
cifrado pelo cofre do sistema (Keychain no macOS, DPAPI no Windows), e os entrega ao Core
em memória a cada conexão. A identidade segue o mesmo caminho.

## Decisão

- O `identity.json` passa a ser um envelope AES-256-GCM:
  `{ v: 1, cifra: "aes-256-gcm", iv, etiqueta, dados }`, com nonce novo a cada gravação.
- A chave de 32 bytes (base64url) é um segredo novo, `remote.identidade`. A extensão
  `fakl-core` a gera na primeira vez, guarda no SecretStorage (`fakl.remote.identidade`) e
  a entrega com `secrets.set` ao conectar. Nunca vai a arquivo, ao config.yaml ou a log.
- O Core só abre a identidade com a chave. Ao iniciar, o gateway espera até 10 s pela chave
  da IDE (sem travar a abertura do Core: `start()` roda em segundo plano).
- Migração automática: se o arquivo ainda estiver em texto e houver chave, o gateway o
  regrava cifrado (troca atômica, que apaga o texto). O segredo e a chave privada são os
  mesmos, então o id da máquina no relay e os aparelhos pareados (`devices.json`) seguem
  valendo.
- Sem a extensão (Core iniciado sozinho, CLI, testes), vale o comportamento anterior: o
  arquivo fica em texto, com aviso no log, e o gateway funciona. Se a chave chegar depois,
  o arquivo é migrado na hora.
- Falhas nunca geram uma identidade nova por cima da existente: arquivo corrompido, arquivo
  cifrado sem a chave ou com a chave errada deixam o gateway em estado de erro, com a
  mensagem dizendo o que fazer, e o arquivo intacto. Uma chave que chega depois tenta de
  novo sozinha.
- Se a IDE trocar a chave, o Core regrava a identidade que tem em memória com a chave nova.

## Consequências

- Perder o SecretStorage (outro perfil, outra máquina, cofre limpo) com o arquivo já cifrado
  impede abrir a identidade. A saída é apagar `identity.json` e `devices.json` e parear os
  aparelhos de novo. Copiar `~/.fakl` para outra máquina não leva a identidade junto, o que
  é o efeito desejado.
- Sem a IDE, o arquivo continua em texto. A proteção vale quando a extensão está conectada,
  que é o uso normal.
- Não coberto aqui: a `chave` do relay em `~/.fakl/config.yaml` (`remoto.chave`) é escrita
  pelo usuário ou pela IDE em texto e segue assim. O gateway só a lê.
- O formato do envelope tem versão (`v`), para trocar o algoritmo no futuro.
