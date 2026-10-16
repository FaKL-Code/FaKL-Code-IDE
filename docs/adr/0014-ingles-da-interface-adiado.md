# 0014. Inglês da interface adiado

- Status: substituída por [0036](0036-idioma-do-sistema-com-pacote-pt-br-embutido.md)
- Data: 2026-10-12
- Requisitos: RNF-15

## Contexto

O RNF-15 pede a interface em português do Brasil com inglês disponível, com
as strings no sistema de localização do VS Code. Hoje as strings da extensão,
dos webviews e do app do celular estão escritas direto em português.

No VS Code, o idioma padrão é o inglês: `package.nls.json` e o texto passado a
`vscode.l10n.t` são lidos como inglês, e um arquivo `pt-br` só vale quando o
pacote de idioma pt-BR está instalado e escolhido. Fazer certo exige três
coisas juntas:

- reescrever todas as strings em inglês;
- mover o português para `package.nls.pt-br.json` e `l10n/bundle.l10n.pt-br.json`;
- embutir no build o pacote de idioma pt-BR, com `locale: pt-br` como padrão.

Sem a terceira parte, a IDE abriria em inglês para o único usuário dela.

## Decisão

Adiar o inglês. A interface continua só em português até haver um segundo
usuário que precise dele. Strings novas seguem escritas direto, como as de
hoje.

## Consequências

- Nada muda para quem usa em português, e o build não ganha uma dependência do Open VSX.
- Quando o inglês for necessário, o trabalho é mecânico, mas grande: as
  strings da extensão e dos webviews, o manifesto e o passo de build do pacote
  de idioma.
