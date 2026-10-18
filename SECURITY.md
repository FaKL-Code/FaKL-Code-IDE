# Segurança

## Reportar uma vulnerabilidade

Não abra issue pública. Use [GitHub Security Advisories](https://github.com/FaKL-Code/FaKL-Code-IDE/security/advisories/new)
deste repositório.

## Regras do projeto

- Nenhum segredo em texto puro no disco, em logs, no vault ou no repositório (RNF-07).
- Credenciais ficam no cofre do sistema (Keychain no macOS, DPAPI no Windows) e
  não sincronizam entre máquinas (SDD 14.2).
- Agentes nunca recebem segredos diretamente; o Core aplica as permissões
  (SDD 14.3).
- Sem telemetria (RNF-09). O que a IDE consulta na rede (npm, GitHub, os serviços que você
  configurou) e como desligar está em [docs/privacidade.md](docs/privacidade.md).
