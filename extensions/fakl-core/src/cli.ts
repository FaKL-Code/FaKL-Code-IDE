import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

/**
 * Põe a CLI `fakl` (dist/fakl.mjs) em ~/.fakl/bin, com um atalho que roda o
 * próprio executável da IDE como Node, e acrescenta a pasta ao PATH dos
 * terminais da IDE. Reescreve a cada abertura, porque o caminho do executável
 * muda com atualizações.
 */
export async function installCli(context: vscode.ExtensionContext): Promise<string | undefined> {
  const script = vscode.Uri.joinPath(context.extensionUri, 'dist', 'fakl.mjs').fsPath;
  const bin = join(homedir(), '.fakl', 'bin');
  await mkdir(bin, { recursive: true });
  const exe = process.execPath;
  if (process.platform === 'win32') {
    await writeFile(
      join(bin, 'fakl.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${script}" %*\r\n`,
    );
  } else {
    const shim = join(bin, 'fakl');
    await writeFile(shim, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe}" "${script}" "$@"\n`);
    await chmod(shim, 0o755);
  }
  const separator = process.platform === 'win32' ? ';' : ':';
  context.environmentVariableCollection.description = l10n.t('Adds the fakl CLI to PATH');
  context.environmentVariableCollection.prepend('PATH', `${bin}${separator}`);
  return bin;
}

const execFileAsync = promisify(execFile);

/**
 * Põe ~/.fakl/bin no PATH do sistema, para a CLI funcionar fora da IDE: no
 * Windows, no PATH do usuário; no macOS, no ~/.zprofile. Só com confirmação.
 * Devolve se a pasta ficou (ou já estava) no PATH.
 */
export async function addCliToSystemPath(): Promise<boolean> {
  const bin = join(homedir(), '.fakl', 'bin');
  const pergunta =
    process.platform === 'win32'
      ? l10n.t(
          "Add {0} to your Windows user PATH? Then the fakl command works in any terminal, not just the IDE's.",
          bin,
        )
      : l10n.t(
          "Add {0} to ~/.zprofile? Then the fakl command works in any terminal, not just the IDE's.",
          bin,
        );
  const choice = await vscode.window.showInformationMessage(
    pergunta,
    { modal: true },
    l10n.t('Add to PATH'),
  );
  if (!choice) return false;
  try {
    if (process.platform === 'win32') {
      // O caminho vai por variável de ambiente, sem montar texto de comando.
      const script = [
        "$atual = [Environment]::GetEnvironmentVariable('Path', 'User')",
        "$partes = @($atual -split ';' | Where-Object { $_ -ne '' })",
        'if ($partes -notcontains $env:FAKL_BIN) {',
        "  [Environment]::SetEnvironmentVariable('Path', (($partes + $env:FAKL_BIN) -join ';'), 'User')",
        "  'acrescentado'",
        "} else { 'presente' }",
      ].join('\n');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, FAKL_BIN: bin } },
      );
      void vscode.window.showInformationMessage(
        stdout.includes('presente')
          ? l10n.t('The folder was already on PATH.')
          : l10n.t('Done. Open a new terminal to use fakl.'),
      );
      return true;
    } else {
      const profile = join(homedir(), '.zprofile');
      const line = 'export PATH="$HOME/.fakl/bin:$PATH"';
      const current = await readFile(profile, 'utf8').catch(() => '');
      if (current.includes('.fakl/bin')) {
        void vscode.window.showInformationMessage(
          l10n.t('~/.zprofile already adds the folder to PATH.'),
        );
        return true;
      }
      await appendFile(
        profile,
        `${current && !current.endsWith('\n') ? '\n' : ''}# CLI do FaKL-Code\n${line}\n`,
      );
      void vscode.window.showInformationMessage(l10n.t('Done. Open a new terminal to use fakl.'));
      return true;
    }
  } catch (error) {
    void vscode.window.showErrorMessage(l10n.t("Couldn't change PATH: {0}", String(error)));
    return false;
  }
}

/** A pasta da CLI já está no PATH com que a IDE abriu. */
export function cliOnPath(): boolean {
  const bin = join(homedir(), '.fakl', 'bin').toLowerCase();
  const separator = process.platform === 'win32' ? ';' : ':';
  return (process.env.PATH ?? '')
    .split(separator)
    .some((entry) => entry.replace(/[\\/]+$/, '').toLowerCase() === bin);
}
