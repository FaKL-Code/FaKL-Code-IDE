import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/** Valor de uma variável sem diferenciar maiúsculas, como o Windows faz. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return (key && env[key]) ?? '';
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Procura um executável no PATH. No Windows tenta as extensões do PATHEXT,
 * porque CLIs instaladas pelo npm viram `nome.cmd`.
 */
export async function findExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // No Windows o npm também cria um script sem extensão, para o Git Bash, que
  // não roda fora dele; por isso o nome puro só vale se já tiver extensão.
  const extensions =
    platform === 'win32'
      ? [
          ...(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean),
          ...(p.extname(command) ? [''] : []),
        ]
      : [''];
  const candidates = (dir: string): string[] =>
    extensions.map((ext) => p.join(dir, command + ext.toLowerCase()));

  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) {
    for (const file of candidates('')) {
      if (await isExecutable(file, platform)) return file;
    }
    return undefined;
  }
  for (const dir of envValue(env, 'PATH').split(p.delimiter).filter(Boolean)) {
    for (const file of candidates(dir)) {
      if (await isExecutable(file, platform)) return file;
    }
  }
  return undefined;
}
