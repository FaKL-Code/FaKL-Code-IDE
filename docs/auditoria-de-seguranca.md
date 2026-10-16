# Auditoria de segredos e dados pessoais

Registro da conferência feita antes de publicar este repositório (2026-10-16). O
repositório público nasceu de um único commit, sem o histórico do repositório de
desenvolvimento privado.

## O que foi conferido

| Verificação                                                             | Ferramenta                                                      | Resultado                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| Segredos no histórico (1 commit, 4,7 MB)                                | gitleaks 8.30.1 (`git`), regras padrão + `.gitleaks.toml`       | Nenhum achado                                              |
| Segredos na árvore (753 arquivos, 18,8 MB)                              | gitleaks 8.30.1 (`dir`)                                         | Nenhum achado                                              |
| Nomes, e-mails, IPs, máquinas e caminhos pessoais                       | `build/termos-proibidos.mjs` (termos guardados só como SHA-256) | Nenhum achado                                              |
| E-mail de autor e committer do commit                                   | `build/termos-proibidos.mjs --commits`                          | Só o e-mail noreply do GitHub                              |
| Chaves e tokens por padrão (`ghp_`, `sk-ant-`, `AKIA`, chaves privadas) | busca por expressão regular na árvore                           | Só detectores e dados falsos de teste                      |
| E-mails, IPv4 e caminhos de usuário                                     | busca por expressão regular na árvore                           | Só exemplos (`exemplo.com`, `203.0.113.x`, `C:/Users/dev`) |
| Arquivos de credencial versionados (`.env`, `.pem`, `.key`)             | `git ls-files`                                                  | Nenhum                                                     |

O binário do gitleaks foi baixado da release oficial e conferido contra o SHA-256
fixado em `.github/workflows/ci.yml`
(`d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`).

## O que impede a volta do problema

- **CI:** o job "Segredos e termos proibidos" roda gitleaks no histórico e a lista de
  termos nos arquivos e nos e-mails dos commits de cada PR. É uma verificação obrigatória
  para mesclar na `main`.
- **GitHub:** secret scanning e push protection ligados no repositório.
- **Lista de termos:** guarda só hashes, então os próprios termos não ficam expostos.
- **Modelo de PR:** pede conferência de segredos e dados pessoais.

## Limites desta auditoria

- Um scanner não prova ausência: ele acha padrões conhecidos e os termos da lista.
  Um segredo de formato desconhecido ou um dado pessoal fora da lista não seria pego.
- Os instaladores e as mídias (imagens, vídeos) foram conferidos como arquivos,
  não pelo conteúdo visual.
- O e-mail noreply do commit inclui o identificador numérico da conta do GitHub
  dos mantenedores, que é público.

Achou algo que não devia estar aqui? Siga o [SECURITY.md](../SECURITY.md).
