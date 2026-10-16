# upstream

Versão do Code-OSS (VS Code) sobre a qual a FaKL-Code IDE é construída.

`stable.json` fixa a tag e o commit do repositório `microsoft/vscode`. Ele segue
o mesmo formato do `upstream/stable.json` do VSCodium, cujos scripts de build
usamos (ADR 0001). Mudar esta versão é sempre um PR próprio, com título
`build(upstream): atualiza code-oss para X.Y.Z`, e precisa passar pelo build
completo antes do merge. O workflow `upstream.yml` (M1) abre esse PR
automaticamente quando sai uma versão nova.

Versão atual: VS Code 1.135.0, a mesma do VSCodium estável em 2026-10-11.

`language-pack-pt-br.json` fixa a versão e o SHA-256 do pacote de idioma pt-BR
do VS Code, baixado do Open VSX pelo `build/prepare.sh` (ADR 0036), e
`language-pack-pt-br.LICENSE.md` é a licença MIT dele, que o `.vsix` não traz.
