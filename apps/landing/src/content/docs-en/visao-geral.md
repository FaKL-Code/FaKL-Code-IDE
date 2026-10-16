---
titulo: 'Overview'
descricao: 'What the FaKL-Code IDE is and how the parts fit together.'
ordem: 1
---

The FaKL-Code IDE is a desktop IDE for Windows and macOS, based on VSCodium, built for AI-assisted development. It brings together in one place the agents you already use (Claude Code, Codex, Gemini CLI, and local models) and shows their work as it happens.

## The parts

- **Desk:** the main canvas. Each agent is a card with state, branch, usage, and cost; wires connect the Maestro to its subagents.
- **Agents chat:** one conversation per agent in the sidebar, with logs, permissions, and the changes ready for review.
- **Maestro:** receives a task, splits it among agents chosen by their profiles, tracks the done criteria, and delivers as a PR.
- **Vault:** your Markdown notes in Obsidian format, which also serve as project memory for the agents.
- **Integrations:** your whole GitHub account, SSH, Hostinger, Lovable, email over IMAP, Open VSX extensions, and MCP servers.
- **Remote control:** the phone app, paired with the IDE through a relay with end-to-end encryption.
- **Cyber café:** the pixel art room where each agent is an avatar working at a computer.

## The FaKL Core

Behind it all runs the FaKL Core, the process that manages agents, tasks, costs, the vault, and integrations. It starts with the IDE and stops when the IDE closes. Nothing runs 24 hours a day: if you close the IDE with agents working, it asks whether to wait for them to finish or stop now.

## Each agent in its own worktree

When an agent works in a worktree, it gets an isolated copy of the repository on its own branch. Your folder does not change until you apply the changes or merge the PR. That way, several agents can work on the same project at the same time without stepping on each other.
