import { spawn } from 'node:child_process';

import { l10n } from '@fakl/i18n';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Guarda só o fim da saída, em caracteres. */
  readonly tailChars?: number;
  /** Windows: passa os argumentos sem as aspas do Node (para o cmd.exe). */
  readonly verbatim?: boolean;
  /** Texto enviado à entrada padrão do programa. */
  readonly input?: string;
}

function keep(text: string, max: number | undefined): string {
  return max !== undefined && text.length > max ? text.slice(-max) : text;
}

/** Roda um programa sem shell; nunca rejeita, o código de saída diz o resultado. */
export function run(
  command: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
      windowsHide: true,
      windowsVerbatimArguments: options.verbatim ?? false,
    });
    // O programa pode fechar a entrada antes do fim (erro de ssh); EPIPE não derruba o Core.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            stderr += `\n${l10n.t('(timed out after {0} ms)', String(options.timeoutMs))}`;
            child.kill();
          }, options.timeoutMs)
        : undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = keep(stdout + chunk.toString('utf8'), (options.tailChars ?? 1_000_000) * 2);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = keep(stderr + chunk.toString('utf8'), (options.tailChars ?? 1_000_000) * 2);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: keep(stdout, options.tailChars),
        stderr: keep(stderr, options.tailChars),
      });
    });
  });
}

/** Roda uma linha de comando no shell do sistema (verificações do critério de pronto). */
export function runShell(commandLine: string, options: ExecOptions): Promise<ExecResult> {
  return process.platform === 'win32'
    ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
        ...options,
        verbatim: true,
      })
    : run('/bin/sh', ['-c', commandLine], options);
}

export async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args[0] ?? ''}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}
