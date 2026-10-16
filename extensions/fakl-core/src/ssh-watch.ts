/*
 * Aviso de mudança para pastas remotas, por consulta leve: o servidor não
 * avisa nada, então de tempos em tempos olhamos a data de modificação (mtime)
 * de cada pasta ou arquivo observado. Pasta que mudou é relida e comparada com
 * a lista anterior, e só então saem os eventos de criado/apagado. Lógica pura,
 * sem `vscode`; `ssh-fs.ts` liga isto ao `onDidChangeFile`.
 */

export type WatchEventType = 'changed' | 'created' | 'deleted';

export interface WatchEvent {
  readonly type: WatchEventType;
  readonly path: string;
}

export interface WatchRemote {
  stat(path: string): Promise<{ kind: 'file' | 'dir' | 'other'; size: number; mtime: number }>;
  list(path: string): Promise<{ name: string }[]>;
}

interface Watched {
  count: number;
  kind?: 'file' | 'dir' | 'other';
  stamp?: string | undefined;
  names?: Set<string> | undefined;
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export class RemotePoller {
  private readonly watched = new Map<string, Watched>();
  private ticking = false;

  constructor(
    private readonly remote: WatchRemote,
    private readonly emit: (events: WatchEvent[]) => void,
  ) {}

  get size(): number {
    return this.watched.size;
  }

  /** Começa a observar `path`; devolve quem para. Pedidos repetidos dividem a mesma consulta. */
  add(path: string): () => void {
    const entry = this.watched.get(path) ?? { count: 0 };
    entry.count++;
    this.watched.set(path, entry);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      const current = this.watched.get(path);
      if (!current) return;
      current.count--;
      if (current.count <= 0) this.watched.delete(path);
    };
  }

  /** Uma rodada: olha cada caminho observado, um de cada vez (o shell remoto é serial). `false` se algum falhou. */
  async tick(): Promise<boolean> {
    if (this.ticking) return true;
    this.ticking = true;
    let ok = true;
    try {
      for (const path of [...this.watched.keys()]) {
        const entry = this.watched.get(path);
        if (!entry) continue;
        const events = await this.check(path, entry).catch(() => undefined);
        // Falha (rede caiu, sem permissão): não gera evento; quem chama espera mais para tentar de novo.
        if (events === undefined) ok = false;
        else if (events.length > 0) this.emit(events);
      }
    } finally {
      this.ticking = false;
    }
    return ok;
  }

  private async check(path: string, entry: Watched): Promise<WatchEvent[]> {
    let stat;
    try {
      stat = await this.remote.stat(path);
    } catch (error) {
      // O shell vivo respondeu que não existe: se existia, foi apagado.
      if (entry.stamp !== undefined && /No such file|cannot stat|não existe/i.test(String(error))) {
        entry.stamp = undefined;
        entry.names = undefined;
        return [{ type: 'deleted', path }];
      }
      throw error;
    }
    const stamp = `${stat.kind}:${String(stat.mtime)}:${String(stat.size)}`;
    const first = entry.stamp === undefined;
    const changed = !first && stamp !== entry.stamp;
    entry.stamp = stamp;
    entry.kind = stat.kind;
    if (stat.kind !== 'dir') return changed ? [{ type: 'changed', path }] : [];
    // Pasta: sem mudança de mtime, nada a ler. Na primeira vez só guarda a lista.
    if (!first && !changed) return [];
    const names = new Set((await this.remote.list(path)).map((e) => e.name));
    const before = entry.names;
    entry.names = names;
    if (!before) return [];
    const events: WatchEvent[] = [];
    for (const name of names)
      if (!before.has(name)) events.push({ type: 'created', path: join(path, name) });
    for (const name of before)
      if (!names.has(name)) events.push({ type: 'deleted', path: join(path, name) });
    return events;
  }
}
