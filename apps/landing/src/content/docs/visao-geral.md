---
titulo: Visão geral
descricao: O que é a FaKL-Code IDE e como as partes se encaixam.
ordem: 1
---

A FaKL-Code IDE é uma IDE desktop para Windows e macOS, baseada no VSCodium, feita para desenvolvimento assistido por IA. Ela reúne num só lugar os agentes que você já usa (Claude Code, Codex, Gemini CLI e modelos locais) e mostra o trabalho deles enquanto acontece.

## As partes

- **Mesa:** o canvas principal. Cada agente é um cartão com estado, branch, uso e custo; fios ligam o Maestro aos subagentes.
- **Chat dos agentes:** uma conversa por agente na barra lateral, com logs, permissões e as alterações prontas para revisar.
- **Maestro:** recebe uma tarefa, divide entre agentes escolhidos pelos perfis, acompanha os critérios de pronto e entrega em PR.
- **Vault:** suas notas Markdown no formato Obsidian, que também servem de memória do projeto para os agentes.
- **Integrações:** GitHub da conta inteira, SSH, Hostinger, Lovable, e-mail por IMAP, extensões do Open VSX e servidores MCP.
- **Controle remoto:** o app no celular, pareado com a IDE por um relay com cifra de ponta a ponta.
- **Cyber café:** a sala em pixel art onde cada agente é um avatar trabalhando num computador.

## O FaKL Core

Por trás de tudo roda o FaKL Core, o processo que gerencia agentes, tarefas, custos, vault e integrações. Ele sobe junto com a IDE e para quando ela fecha. Nada roda 24 horas por dia: se você fechar a IDE com agentes trabalhando, ela pergunta se deve esperar terminar ou parar agora.

## Cada agente no seu worktree

Quando um agente trabalha num worktree, ele recebe uma cópia isolada do repositório num branch próprio. A sua pasta não muda até você aplicar as alterações ou fazer merge do PR. Assim, vários agentes podem mexer no mesmo projeto ao mesmo tempo sem pisar um no outro.
