import type * as vscode from 'vscode';

const CLAUDE_CONFIG_DIR = 'CLAUDE_CONFIG_DIR';

export type TerminalReopenPlan =
  | { readonly kind: 'skip'; readonly reason: 'login' | 'pty' | 'ssh' }
  | { readonly kind: 'reopen'; readonly options: vscode.TerminalOptions };

function environmentValue(
  env: vscode.TerminalOptions['env'],
  variable: string,
): string | null | undefined {
  const found = Object.entries(env ?? {}).find(
    ([name]) => name.toUpperCase() === variable.toUpperCase(),
  );
  return found?.[1];
}

function isClaudeLogin(options: Readonly<vscode.TerminalOptions>): boolean {
  return (
    options.name?.startsWith('Claude: ') === true &&
    typeof environmentValue(options.env, CLAUDE_CONFIG_DIR) === 'string'
  );
}

function isSsh(options: Readonly<vscode.TerminalOptions>): boolean {
  const executable = options.shellPath?.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  return executable === 'ssh' || executable === 'ssh.exe';
}

/**
 * Monta uma cópia reproduzível do terminal, preservando todas as opções de
 * criação e alterando só a conta do Claude. `null` remove a variável também
 * do ambiente herdado; com `strictEnv`, o restante do ambiente segue intacto.
 */
export function planTerminalReopen(
  creationOptions: Readonly<vscode.TerminalOptions | vscode.ExtensionTerminalOptions>,
  configDir: string | undefined,
  knownLogin = false,
): TerminalReopenPlan {
  if ('pty' in creationOptions) return { kind: 'skip', reason: 'pty' };
  if (knownLogin || isClaudeLogin(creationOptions)) return { kind: 'skip', reason: 'login' };
  // Os terminais SSH do FaKL têm estado e registro próprios no SshUi. Mesmo
  // copiando shellPath/args, recriá-los daqui quebraria esse vínculo.
  if (isSsh(creationOptions)) return { kind: 'skip', reason: 'ssh' };

  const env = Object.fromEntries(
    Object.entries(creationOptions.env ?? {}).filter(
      ([name]) => name.toUpperCase() !== CLAUDE_CONFIG_DIR,
    ),
  );
  env[CLAUDE_CONFIG_DIR] = configDir ?? null;
  return {
    kind: 'reopen',
    options: { ...creationOptions, env },
  };
}
