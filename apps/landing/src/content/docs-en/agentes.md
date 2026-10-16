---
titulo: 'Agents and profiles'
descricao: 'Profiles, worktrees, permission modes, Claude accounts, and resuming.'
ordem: 3
---

## Agent profiles

A profile describes a reusable agent: provider, model, strengths, relative cost, allowed tools, and rules. Create and edit profiles with the **New agent profile** and **Edit profile** commands. The Maestro uses each profile's strengths and cost to decide who does what.

The IDE ships with ready-made profiles for Claude Code (Haiku, Sonnet, and Opus), Codex, and Gemini CLI. A profile with a custom command runs any ACP-compatible agent, and a profile for the local adapter uses Ollama or LM Studio.

## Talking to an agent

Open the chat with **Open agents chat** or create one with **New agent**. In each session you can:

- pause, resume, and stop the agent;
- open the log and a terminal in the agent's folder;
- switch the model, reasoning, and other options the agent offers;
- see the changed files and apply or discard each one.

Sessions are saved. If the IDE closes in the middle of the work, the conversation comes back intact, and a new message resumes the agent in the same worktree.

## Permission modes

| Mode              | What the agent can do on its own                                                  |
| ----------------- | --------------------------------------------------------------------------------- |
| `perguntar`       | Nothing: every action waits for your approval (Ask)                               |
| `aprovar-leitura` | Read and search; editing and running commands still ask (Approve reads)           |
| `aprovar-tudo`    | Everything, inside the worktree (Approve all)                                     |
| `autopilot`       | Everything, and the run's decisions are answered with the safe option (Autopilot) |

In Autopilot, the work stays on the agent's branch and reaches `main` through a PR. SSH commands, Hostinger actions, and sending secrets always wait for you, in any mode. The mode can change while the agent is running, from the chat, from your phone, or with `fakl modo <sessão> <modo>`.

## Claude accounts in parallel

The IDE keeps up to three Claude accounts, each in its own folder, without mixing with your `~/.claude`. Sign in to each one with **Sign in to a Claude account** and switch the active account with **Claude: Switch account**. Open agents switch along with it, without losing the conversation. The status bar shows usage for the 5-hour and weekly windows.

## When the provider hits its limit

If an agent hits the provider's session limit, the task is paused instead of failing. You can resume right away, switch accounts, or turn on automatic resume, which waits until the time the provider reports. The waiting time does not count toward the task's time.
