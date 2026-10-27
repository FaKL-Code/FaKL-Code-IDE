# 0054. Versão interna dentro do limite do Windows

- Status: aceita
- Data: 2026-10-27
- Requisitos: RF-003; ADR 0037 (substitui a parte "em seis dígitos")

## Contexto

A ADR 0037 montou o RELEASE_VERSION como a tag do Code-OSS seguida de `X*10000 + Y*100 + Z` em
seis dígitos. O VSCodium exige que o terceiro número comece com o patch do Code-OSS (`[0-5]`) e
o usa para descobrir a tag. A v0.1.18 foi a primeira release sobre um Code-OSS com patch diferente
de zero (1.143.1): o terceiro número ficou `1000118`.

O Windows aceita no máximo 65535 em cada parte do `VersionInfoVersion` do instalador. O Inno
Setup recusou `1.143.1000118` e o build do Windows caiu depois de seis minutos de compilação.
Linux e macOS não validam isso e passaram. Com o patch em 0 (1.135.0 e 1.140.0) o número era 117
e cabia, por isso a falha só apareceu agora.

## Decisão

- O contador passa a ter **quatro** dígitos: o terceiro número é `patch*10000 + contador`, no
  máximo 59999. Para o Code-OSS com patch 0 o valor é o mesmo de antes (`1.140.0000117` e
  `1.140.00117` valem 117), então quem está nas versões anteriores se atualiza sem mudança.
- O `build/versao.mjs` recusa uma tag cujo contador passe de 9999 (a `v1.0.0` em diante), com uma
  mensagem que cita esta ADR, no passo "Versão do app", antes de compilar. Na `v1.0.0` o esquema
  precisa ser revisto.
- `tagDaRelease` continua lendo os seis dígitos das releases até a v0.1.17. A versão da data do
  build também tem quatro dígitos e agora parece uma tag; o `manifestos-update.mjs` já compara o
  resultado com a tag pedida, então um build sem tag não vira manifesto de release.

## Consequências

- Uma versão do app como `1.143.10118` é mais difícil de ler que `1.143.118`, mas o mapa entre a
  tag e a versão fica no `docs/build.md`.
- O teste `versao.test.mjs` verifica que o terceiro número cabe em 65535 para os patches 0 a 5, e
  que o caminho real da v0.1.17 para a v0.1.18 é uma atualização.

## Alternativas consideradas

- **Ignorar o patch do Code-OSS e usar sempre `X.Y.0`:** o VSCodium usa o dígito que está no
  RELEASE_VERSION como tag do Code-OSS e baixaria o código errado.
- **Manter seis dígitos e limitar o Code-OSS a patch 0:** deixaria a IDE presa a versões `.0` do
  VS Code, sem as correções de segurança dos patches.
