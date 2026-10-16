import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';

import { planTerminalReopen } from '../src/claude-terminal.js';

describe('planTerminalReopen', () => {
  it('preserva todas as opções e troca só o ambiente da conta', () => {
    const iconPath = { id: 'terminal' } as vscode.ThemeIcon;
    const color = { id: 'terminal.ansiBlue' } as vscode.ThemeColor;
    const location = {
      viewColumn: 2,
      preserveFocus: true,
    } as unknown as vscode.TerminalEditorLocationOptions;
    const options: vscode.TerminalOptions = {
      name: 'desenvolvimento',
      shellPath: 'pwsh',
      shellArgs: ['-NoLogo'],
      cwd: 'C:\\projeto',
      env: { KEEP: 'sim', CLAUDE_CONFIG_DIR: 'antiga' },
      strictEnv: true,
      hideFromUser: true,
      message: 'iniciando',
      iconPath,
      color,
      location,
      isTransient: true,
      shellIntegrationNonce: 'nonce',
    };

    const plan = planTerminalReopen(options, 'C:\\contas\\2');

    expect(plan.kind).toBe('reopen');
    if (plan.kind !== 'reopen') return;
    expect(plan.options).toEqual({
      ...options,
      env: { KEEP: 'sim', CLAUDE_CONFIG_DIR: 'C:\\contas\\2' },
    });
    expect(plan.options.shellArgs).toBe(options.shellArgs);
    expect(plan.options.iconPath).toBe(iconPath);
    expect(plan.options.color).toBe(color);
    expect(plan.options.location).toBe(location);
  });

  it('remove a conta anterior sem perder o ambiente strictEnv', () => {
    const plan = planTerminalReopen(
      {
        name: 'limpo',
        env: { KEEP: 'sim', claude_config_dir: 'antiga' },
        strictEnv: true,
      },
      undefined,
    );

    expect(plan.kind).toBe('reopen');
    if (plan.kind !== 'reopen') return;
    expect(plan.options.strictEnv).toBe(true);
    expect(plan.options.env).toEqual({ KEEP: 'sim', CLAUDE_CONFIG_DIR: null });
  });

  it('não tenta reproduzir pseudoterminais, SSH ou logins do Claude', () => {
    expect(
      planTerminalReopen({ name: 'extensão', pty: {} as vscode.Pseudoterminal }, 'C:\\contas\\1'),
    ).toEqual({ kind: 'skip', reason: 'pty' });
    expect(
      planTerminalReopen(
        { name: 'SSH servidor', shellPath: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' },
        'C:\\contas\\1',
      ),
    ).toEqual({ kind: 'skip', reason: 'ssh' });
    expect(
      planTerminalReopen(
        { name: 'Claude: Trabalho', env: { CLAUDE_CONFIG_DIR: 'C:\\contas\\3' } },
        'C:\\contas\\1',
      ),
    ).toEqual({ kind: 'skip', reason: 'login' });
    expect(planTerminalReopen({ name: 'login' }, 'C:\\contas\\1', true)).toEqual({
      kind: 'skip',
      reason: 'login',
    });
  });
});
