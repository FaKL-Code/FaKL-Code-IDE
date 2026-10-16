import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Armazenamento do Core em arquivos (ADR 0007): registros só de inserção em
 * JSON Lines e documentos JSON gravados de forma atômica. Fica em
 * `~/.fakl/data`, que não sincroniza entre máquinas.
 */
export class JsonlLog<T> {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  /** Lê todas as linhas válidas; uma linha cortada por queda no meio da gravação é ignorada. */
  async readAll(): Promise<T[]> {
    const text = await readFile(this.path, 'utf8').catch(() => '');
    const entries: T[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // Linha incompleta.
      }
    }
    return entries;
  }

  /** Acrescenta em ordem, uma gravação por vez. */
  append(entry: T): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, { mode: 0o600 });
    });
    return this.queue;
  }

  /** Troca o conteúdo do arquivo, na vez das gravações pendentes (compactação). */
  replace(entries: readonly T[]): Promise<void> {
    const text = entries
      .map(
        (entry) => `${JSON.stringify(entry)}
`,
      )
      .join('');
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${String(process.pid)}.compact.tmp`;
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, this.path);
    });
    return this.queue;
  }

  /** Espera as gravações pendentes. */
  flush(): Promise<void> {
    return this.queue;
  }
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Erros do Windows ao renomear sobre um arquivo que outro processo tem aberto. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * No Windows, o rename falha enquanto alguém lê o destino (outro processo, o
 * antivírus); a leitura acaba logo, então tenta de novo por uns 3 s em vez de
 * perder a gravação.
 */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !code || !BUSY.has(code) || attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** Math.min(attempt, 6)));
    }
  }
}

/** Gravações em andamento por arquivo: uma de cada vez, na ordem em que foram pedidas. */
const writing = new Map<string, Promise<void>>();
let tempCounter = 0;

/**
 * Grava num arquivo temporário e renomeia, para nunca deixar o documento pela
 * metade. Duas gravações do mesmo arquivo ao mesmo tempo esperam a vez: com o
 * mesmo temporário, a segunda renomeava um arquivo que a primeira já tinha levado.
 */
export function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const previous = writing.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${String(process.pid)}.${String(++tempCounter)}.tmp`;
    await writeFile(temp, text, { mode: 0o600 });
    await renameRetrying(temp, path).catch(async (error: unknown) => {
      await unlink(temp).catch(() => undefined);
      throw error;
    });
  });
  const settled = next.catch(() => undefined);
  writing.set(path, settled);
  void settled.then(() => {
    if (writing.get(path) === settled) writing.delete(path);
  });
  return next;
}
