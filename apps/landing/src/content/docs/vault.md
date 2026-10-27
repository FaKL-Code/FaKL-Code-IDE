---
titulo: Vault
descricao: Notas Markdown no formato Obsidian, grafo, busca e memória do projeto.
ordem: 6
---

## Sua pasta de notas

O vault é uma pasta de arquivos Markdown, compatível com o Obsidian. Configure com **Configurar o vault**. A IDE oferece:

- **explorador de notas** numa barra lateral própria (o ícone do Vault), com pastas, a nota aberta sempre marcada, Backlinks e Tags;
- **grafo** das notas (**Abrir o grafo do vault**);
- links e backlinks, tags e templates (**Inserir template do vault**);
- **nota de hoje** e **Anotar no diário**;
- busca por texto e **busca semântica** opcional, com embeddings locais;
- **sync por Git** (**Sincronizar o vault**), para usar o mesmo vault em mais de uma máquina;
- **playbooks**: uma nota vira tarefa com **Transformar esta nota em tarefa**.

## Memória do projeto

O vault também é a memória dos agentes. Cada repositório tem uma pasta `Projetos/<projeto>/`. Ao fim de cada execução, o Core grava a nota da sessão, atualiza a nota-índice do projeto, o `Devlog.md` e o diário do dia. O Maestro lê essa pasta antes de planejar e registra decisões de arquitetura e preferências suas em notas.

Os agentes acessam o vault por um servidor MCP próprio, com leitura e busca.
