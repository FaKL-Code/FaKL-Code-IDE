# @fakl/protocol

Tipos e contratos compartilhados por todos os clientes do FaKL Core: extensões
embutidas, CLI e controle remoto.

- `jsonrpc`: mensagens JSON-RPC 2.0, códigos de erro e verificadores de tipo.
- `methods`: catálogo de métodos `domínio.ação` da API local (SDD 6.3).
- `events`: envelope e tópicos dos eventos do Core (SDD 6.4).

Este pacote não tem dependências de runtime e não faz I/O.
