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

Download from the [Download](/en/download/) page or from the [GitHub Releases](https://github.com/FaKL-Code/FaKL-Code-IDE/releases) and check the hash in `SHA256SUMS.txt`. The installers are not digitally signed yet:

- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** unzip the `.zip`, move the app to Applications and, once, open it with right-click, **Open**. Running `xattr -dr com.apple.quarantine "/Applications/FaKL-Code IDE.app"` in Terminal also works.

## After installing

1. **Install the CLIs for the agents you want to use** and sign in with your account in each one: Claude Code, Codex, and Gemini CLI. The IDE uses their logins; the Core does not read credentials.
2. **Local models (optional):** install Ollama or LM Studio. The IDE's local adapter talks to them and gives the model the tools to read, search, edit, and run commands inside the worktree.
3. **Put the CLI on the PATH:** run the **Add the fakl CLI to the system PATH** command from the command palette to use `fakl` in any terminal.
4. **Sign in to GitHub** with the **Sign in to GitHub** command and, if you use it, **Connect to Hostinger**.
5. **Set up the vault** with **Set up the vault**, pointing to your notes folder.
6. **Pair your phone** with **Pair a device for remote access**, if you want to follow along from afar.

## Updates

On Windows, the IDE checks for a new version by itself, downloads the installer, and asks you to restart. v0.1.0 does not have this: install v0.1.4 or newer by hand once, and from then on the app updates itself. On macOS the IDE tells you a new version is out and opens the download page; install it the way you did the first time. To turn the check off, set `update.mode` to `none`.
