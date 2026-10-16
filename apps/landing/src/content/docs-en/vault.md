---
titulo: 'Vault'
descricao: 'Markdown notes in Obsidian format, graph, search, and project memory.'
ordem: 6
---

## Your notes folder

The vault is a folder of Markdown files, compatible with Obsidian. Set it up with **Set up the vault**. The IDE offers:

- a **graph** of the notes (**Open the vault graph**);
- links and backlinks, tags, and templates (**Insert vault template**);
- **Today's note** (the daily note) and **Add to daily note**;
- text search and optional **Semantic search**, with local embeddings;
- **Git sync** (**Sync the vault**), to use the same vault on more than one machine;
- **playbooks**: a note becomes a task with **Turn this note into a task**.

## Project memory

The vault is also the agents' memory. Each repository has a `Projetos/<projeto>/` folder. At the end of each run, the Core writes the session note, updates the project's index note, the `Devlog.md`, and the daily note. The Maestro reads that folder before planning and records architecture decisions and your preferences in notes.

Agents access the vault through their own MCP server, with read and search.
