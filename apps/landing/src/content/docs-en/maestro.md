---
titulo: 'Maestro and tasks'
descricao: 'Tasks, done criteria, limits, daily cap, decisions, and delivery.'
ordem: 4
---

## A task

Create a task with **New task for the maestro** or, from free-form text, with **Put the maestro to work**. A task has:

- the request and the repository;
- the Maestro's profile;
- the **done criteria**, such as commands that must pass (`pnpm test; pnpm lint`);
- the delivery method: merge, PR, PR with merge, or just the branch;
- the permission mode.

The Maestro plans, creates subagents chosen by their profiles, waits for the results, reviews the diffs, and brings the work together. Each turn of this cycle is a **round**. The run ends when the done criteria pass.

## Limits

Rounds, time, tokens, and cost have limits. The value applies to everything (`~/.fakl/config.yaml`), per playbook, or per task, and the most specific one wins. When a limit is exceeded, what you configured happens:

| Action                | What it does                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `perguntar` (default) | Pauses the run and creates a decision: raise the limit, deliver a draft, escalate, or discard |
| `rascunho`            | Delivers what exists so far as a draft PR                                                     |
| `escalar`             | Swaps the Maestro for a stronger profile, with an extra budget                                |
| `descartar`           | Ends the run and discards the work                                                            |

On top of that, there is a **daily spending cap** per provider, adjusted with **Adjust daily spending cap**. Spending shows live on the Desk and in the **Agent spending today** command.

## Pending decisions

When the run needs you, a decision is created: a limit that was exceeded, a possible secret in the diff, a question from the Maestro. They appear in **Pending decisions**, on the Desk, on your phone, and in `fakl decisoes`.

## Orchestrating from the chat

A regular chat conversation can also call subagents. The conversation becomes the Maestro of a run with no deadline or budget, and the Desk draws the wires the same way.
