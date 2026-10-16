import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { faklHome } from './paths.js';

/**
 * Como chegar ao Core em execução. Gravado pelo próprio Core ao iniciar, para
 * que extensões e CLI achem o endereço e o token da sessão (SDD 4.1).
 */
export interface CoreInfo {
  readonly socketPath: string;
  readonly token: string;
  readonly pid: number;
}

/** ~/.fakl/run/core.json */
export function coreInfoPath(home: string): string {
  return join(faklHome(home), 'run', 'core.json');
}

/** Grava o arquivo legível só pelo usuário, porque ele contém o token. */
export async function writeCoreInfo(path: string, info: CoreInfo): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  // O mode do writeFile só vale na criação; um arquivo antigo mantém o dele.
  await chmod(path, 0o600);
}

export async function readCoreInfo(path: string): Promise<CoreInfo | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const value = JSON.parse(text) as Partial<CoreInfo>;
  if (
    typeof value.socketPath !== 'string' ||
    typeof value.token !== 'string' ||
    typeof value.pid !== 'number'
  ) {
    return undefined;
  }
  return { socketPath: value.socketPath, token: value.token, pid: value.pid };
}

/** Remove o arquivo só se ele ainda for deste processo. */
export async function removeCoreInfo(path: string, pid: number): Promise<void> {
  const current = await readCoreInfo(path).catch(() => undefined);
  if (current?.pid === pid) await rm(path, { force: true });
}
