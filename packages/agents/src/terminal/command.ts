import type { AgentProfile } from '../types.js';

/** O que a extensão executa no terminal: vem só do perfil. */
export interface TerminalCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Comando de um perfil de terminal. O executável e os argumentos são os do
 * perfil, sem montagem de texto de shell: a extensão os passa separados ao
 * terminal (`shellIntegration.executeCommand(executável, args)`), que cuida do
 * quoting do shell do usuário.
 */
export function terminalCommandForProfile(profile: AgentProfile): TerminalCommand {
  const command = profile.comando?.trim();
  if (!command) throw new Error(`profile ${profile.id}: terminal adapter needs a comando`);
  return { command, args: [...(profile.args ?? [])], env: { ...profile.env } };
}

export type ShellFlavor = 'posix' | 'powershell' | 'cmd';

const SAFE = /^[\w@%+=:,./\\~-]+$/;

/** Uma palavra de linha de comando para o shell dado; usada só para texto que o usuário vê e edita. */
export function quoteArg(arg: string, shell: ShellFlavor): string {
  if (arg !== '' && SAFE.test(arg)) return arg;
  if (shell === 'cmd') return `"${arg.replace(/"/g, '""')}"`;
  if (shell === 'powershell') return `'${arg.replace(/'/g, "''")}'`;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function commandLine(
  command: string,
  args: readonly string[],
  shell: ShellFlavor = 'posix',
): string {
  return [command, ...args].map((part) => quoteArg(part, shell)).join(' ');
}

/** Tipo de shell a partir do caminho dele (o terminal integrado do VS Code não o diz de outro jeito). */
export function shellFlavor(shellPath: string | undefined, platform: NodeJS.Platform): ShellFlavor {
  const name = (shellPath ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name.startsWith('pwsh') || name.startsWith('powershell')) return 'powershell';
  if (name.startsWith('cmd')) return 'cmd';
  if (name === '' && platform === 'win32') return 'powershell';
  return 'posix';
}

/** Comando de retomar a MESMA conversa do agente no CLI oficial do provedor. */
export interface ResumeSuggestion {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Conferido com `--help` do CLI na máquina de verificação. Os não conferidos
   * abrem editáveis, para o usuário corrigir antes de executar.
   */
  readonly confirmed: boolean;
}

/**
 * `claude --resume <id>` e `gemini --resume latest` foram conferidos nos `--help`
 * das versões instaladas na verificação. O Gemini retoma por "latest" ou por
 * índice, não pelo id da sessão ACP; `codex resume <id>` não pôde ser conferido
 * (CLI não instalada) e o id da sessão ACP pode não ser o do CLI.
 */
export function resumeSuggestion(
  provedor: string | undefined,
  remoteSessionId: string | undefined,
): ResumeSuggestion | undefined {
  switch (provedor) {
    case 'anthropic':
      return remoteSessionId
        ? { command: 'claude', args: ['--resume', remoteSessionId], confirmed: true }
        : { command: 'claude', args: ['--continue'], confirmed: true };
    case 'google':
      return { command: 'gemini', args: ['--resume', 'latest'], confirmed: true };
    case 'openai':
      return remoteSessionId
        ? { command: 'codex', args: ['resume', remoteSessionId], confirmed: false }
        : { command: 'codex', args: ['resume', '--last'], confirmed: false };
    default:
      return undefined;
  }
}
