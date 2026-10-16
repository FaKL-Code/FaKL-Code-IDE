import { userInfo } from 'node:os';
import { join } from 'node:path';

/** ~/.fakl, ou %USERPROFILE%\.fakl no Windows (SDD 6.5). */
export function faklHome(home: string): string {
  return join(home, '.fakl');
}

/**
 * Endereço da API local (SDD 4.1): named pipe por usuário no Windows e socket
 * Unix em ~/.fakl/run/core.sock nos demais.
 */
export function coreSocketPath(
  platform: NodeJS.Platform,
  home: string,
  user: string = userInfo().username,
): string {
  if (platform === 'win32') {
    const safeUser = user.replace(/[^A-Za-z0-9_.-]/g, '_');
    return `\\\\.\\pipe\\fakl-core-${safeUser}`;
  }
  return join(faklHome(home), 'run', 'core.sock');
}
