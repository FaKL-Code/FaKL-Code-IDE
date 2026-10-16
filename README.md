# FaKL-Code IDE

![FaKL-Code IDE](docs/marca/banner.png)

IDE desktop para Windows e macOS, baseada no VSCodium, feita para desenvolvimento
assistido por IA: central de agentes (Claude, Codex, Gemini, modelos locais) com
orquestração por maestro, vault Markdown compatível com Obsidian, GitHub, SSH,
Hostinger, email IMAP e Lovable integrados, controle remoto pelo celular e um cyber café onde
os agentes trabalham.

> Marcos M1 a M6 entregues. Interface em português (Brasil) e em inglês. Fora do
> escopo por enquanto: atualização automática e IDE no navegador (ADR 0009).

## Marcos

| Marco | Entrega                                                                  | Estado    |
| ----- | ------------------------------------------------------------------------ | --------- |
| M1    | IDE com marca, instaladores, atualização, Open VSX, importação e sync    | Concluído |
| M2    | Core, adaptadores de agentes, mesa de controle, maestro, loops e limites | Concluído |
| M3    | Controle remoto: relay, pareamento, PWA, push, editor no navegador       | Concluído |
| M4    | Vault Obsidian com sync por git, índice e MCP do vault                   | Concluído |
| M5    | GitHub completo, SSH com políticas, Hostinger e Lovable                  | Concluído |
| M6    | Cyber café: sala, avatares, miniaturas e placar                          | Concluído |

## Documentação

- [SDD](docs/sdd.md): requisitos, arquitetura e contratos.
- [ADRs](docs/adr/): decisões de arquitetura.
- [Provedores de IA](docs/provedores.md): assinatura, chave de API, modelo local ou agente ACP, em qualquer combinação.
- [GitHub da conta inteira](docs/github.md): painéis, ferramentas dos agentes, SSO e tokens.
- [Email na IDE](docs/email.md): conexão IMAP, armazenamento seguro e ferramentas de leitura para agentes.
- [Como contribuir](CONTRIBUTING.md): ambiente, fluxo de git e padrões.

## Instalação

Baixe o instalador na página de [Releases](../../releases) e confira o hash em
`SHA256SUMS.txt`.

- **Windows:** execute o `.exe`. Se o instalador não estiver assinado, o SmartScreen
  mostra "O Windows protegeu o computador": clique em **Mais informações** e em
  **Executar assim mesmo**.
- **macOS (Apple Silicon):** o app não é notarizado pela Apple, então o macOS bloqueia
  a primeira abertura. Descompacte o `.zip`, mova o app para Applications e, uma vez,
  libere-o de um destes jeitos:
  - clique com o botão direito no app, **Abrir** e confirme; ou
  - rode `xattr -dr com.apple.quarantine "/Applications/FaKL-Code IDE.app"` no Terminal.

Na primeira abertura, a jornada de configuração guia a escolha de provedores de IA
(todos opcionais), GitHub, vault e as demais integrações.

## Desenvolvimento

```sh
corepack enable
pnpm install
pnpm check
```

## Licença

Copyright (c) 2026 FaKL-Code. Distribuído sob a [GNU AGPL-3.0](LICENSE)
(`AGPL-3.0-only`). O código do VS Code e do VSCodium mantém suas licenças MIT
originais, e os componentes de terceiros mantêm as licenças deles.
