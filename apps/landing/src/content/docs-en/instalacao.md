---
titulo: 'Installation'
descricao: 'Platforms, distribution, and the first steps after installing.'
ordem: 2
---

## Platforms

| System  | Installer     | Requirement                  |
| ------- | ------------- | ---------------------------- |
| Windows | x64           | Windows 10 or 11, 64-bit     |
| macOS   | Apple Silicon | Mac with an M1 chip or newer |

The installers have not been published yet. When they are out, they will be on the [Download](/en/download/) page. Meanwhile, the source code is open on [GitHub](https://github.com/FaKL-Code/FaKL-Code-IDE).

## After installing

1. **Install the CLIs for the agents you want to use** and sign in with your account in each one: Claude Code, Codex, and Gemini CLI. The IDE uses their logins; the Core does not read credentials.
2. **Local models (optional):** install Ollama or LM Studio. The IDE's local adapter talks to them and gives the model the tools to read, search, edit, and run commands inside the worktree.
3. **Put the CLI on the PATH:** run the **Add the fakl CLI to the system PATH** command from the command palette to use `fakl` in any terminal.
4. **Sign in to GitHub** with the **Sign in to GitHub** command and, if you use it, **Connect to Hostinger**.
5. **Set up the vault** with **Set up the vault**, pointing to your notes folder.
6. **Pair your phone** with **Pair a device for remote access**, if you want to follow along from afar.

## Updates

There is no automatic update yet. Each new version arrives as a new installer.
