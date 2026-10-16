import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Endereço de socket isolado por teste: pipe no Windows, arquivo nos demais. */
export async function testSocket(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (process.platform === 'win32') {
    return {
      path: `\\\\.\\pipe\\fakl-test-${randomBytes(6).toString('hex')}`,
      cleanup: () => Promise.resolve(),
    };
  }
  const dir = await mkdtemp(join(tmpdir(), 'fakl-core-'));
  return {
    path: join(dir, 'run', 'core.sock'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error('tempo esgotado esperando a condição'));
      } else {
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}
