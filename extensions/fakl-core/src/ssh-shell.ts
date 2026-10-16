import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { l10n } from '@fakl/i18n';

/*
 * Um `sh` remoto de vida longa pelo ssh do sistema, para a pasta remota
 * (RF-504) sem instalar nada no servidor nem extensão na IDE. Cada pedido
 * vira um bloco de shell seguido de um marcador com o código de saída; a
 * saída dos pedidos não se mistura porque eles rodam um de cada vez.
 */

/** Marcador de fim de pedido: separador de registro (0x1e), id e código. */
const MARK = `${String.fromCharCode(0x1e)}FAKL`;
const MARK_LINE = new RegExp(`\n${MARK} (\\d+) (\\d+)\n`);

export type RemoteKind = 'file' | 'dir' | 'other';

export interface RemoteStat {
  readonly kind: RemoteKind;
  readonly size: number;
  /** Segundos desde 1970. */
  readonly mtime: number;
}

export interface RemoteEntry {
  readonly name: string;
  readonly kind: RemoteKind;
}

export class RemoteError extends Error {
  override readonly name = 'RemoteError';
  constructor(
    message: string,
    readonly code: number,
    /** A conexão caiu (ou nem abriu), em vez de o comando falhar. */
    readonly lost = false,
  ) {
    super(message);
  }
}

/**
 * Multiplexação de conexões (ControlMaster): terminal, pasta remota e comandos
 * do mesmo host compartilham uma conexão TCP. O OpenSSH do Windows não
 * implementa ControlMaster (sem multiplexação por socket Unix), então lá fica
 * desligado e cada processo abre a sua conexão.
 */
export function multiplexArgs(platform: string = process.platform): string[] {
  if (platform === 'win32') return [];
  return [
    '-o',
    'ControlMaster=auto',
    // %C é um hash curto de usuário, host e porta: cabe no limite de 104 bytes do socket.
    '-o',
    'ControlPath=/tmp/fakl-ssh-%C',
    '-o',
    'ControlPersist=60',
  ];
}

/** Aspas simples do sh: `it's` vira `'it'\''s'`. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface Pending {
  readonly id: number;
  readonly resolve: (output: string) => void;
  readonly reject: (error: Error) => void;
}

export interface ShellOptions {
  /** Programa e argumentos que abrem o shell (`ssh -T host sh`, ou `sh` nos testes). */
  readonly command: string;
  readonly args: readonly string[];
  /** Quanto esperar um pedido antes de desistir. */
  readonly timeoutMs?: number;
}

export class RemoteShell {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private stderr = '';
  private nextId = 1;
  private pending: Pending | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private home: string | undefined;
  /** Já houve uma conexão boa: uma queda depois disso pode ser refeita. */
  private connectedOnce = false;

  constructor(private readonly options: ShellOptions) {}

  private connect(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.options.command, [...this.options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2_000);
    });
    const fail = (error: Error) => {
      // `spawn` sem o ssh no PATH chega aqui antes do `exit`.
      if (this.child !== child) return;
      this.child = undefined;
      this.buffer = '';
      const pending = this.pending;
      this.pending = undefined;
      pending?.reject(error);
    };
    child.on('error', fail);
    child.on('exit', (code) => {
      const detail = this.stderr.trim();
      fail(
        new RemoteError(
          detail || l10n.t('the SSH connection closed (exit code {0})', String(code ?? '?')),
          code ?? -1,
          true,
        ),
      );
    });
    this.child = child;
    return child;
  }

  private drain(): void {
    const pending = this.pending;
    if (!pending) return;
    // O bloco sempre termina com uma quebra de linha antes do marcador.
    const text = this.buffer.startsWith(MARK) ? `\n${this.buffer}` : this.buffer;
    const match = MARK_LINE.exec(text);
    if (!match) return;
    const id = Number(match[1]);
    const code = Number(match[2]);
    const output = text.slice(0, match.index);
    this.buffer = text.slice(match.index + match[0].length);
    if (id !== pending.id) return;
    this.connectedOnce = true;
    this.pending = undefined;
    if (code === 0) pending.resolve(output);
    else
      pending.reject(new RemoteError(output.trim() || l10n.t('exit code {0}', String(code)), code));
  }

  /** Roda um trecho de shell e devolve a saída (stdout e stderr juntos). */
  run(script: string): Promise<string> {
    const next = this.queue.then(() => this.send(script));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Como `run`, para pedidos que podem se repetir sem efeito (leituras): se a
   * conexão que já funcionava caiu no meio, reconecta e tenta mais uma vez.
   */
  private runRead(script: string): Promise<string> {
    return this.run(script).catch((error: unknown) => {
      if (error instanceof RemoteError && error.lost && this.connectedOnce) {
        return this.run(script);
      }
      throw error;
    });
  }

  private send(script: string): Promise<string> {
    const child = this.connect();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        // Sem saber em que ponto o shell ficou, começa de novo na próxima.
        this.close();
        reject(new RemoteError(l10n.t('the server did not respond in time'), -1, true));
      }, this.options.timeoutMs ?? 30_000);
      this.pending = {
        id,
        resolve: (output) => {
          clearTimeout(timer);
          resolve(output);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      child.stdin.write(
        `{\n${script}\n} 2>&1 </dev/null; printf '\\n${MARK} %d %d\\n' ${String(id)} $?\n`,
      );
    });
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.buffer = '';
    child?.stdin.end();
    child?.kill();
  }

  /** Pasta pessoal no servidor, para traduzir `~`. */
  async homeDir(): Promise<string> {
    this.home ??= (await this.runRead('printf %s "$HOME"')).trim() || '/';
    return this.home;
  }

  async stat(path: string): Promise<RemoteStat> {
    const out = await this.runRead(`stat -L -c '%f %s %Y' -- ${quote(path)}`);
    const [mode = '0', size = '0', mtime = '0'] = out.trim().split(/\s+/);
    const type = Number.parseInt(mode, 16) & 0xf000;
    return {
      kind: type === 0x4000 ? 'dir' : type === 0x8000 ? 'file' : 'other',
      size: Number(size),
      mtime: Number(mtime),
    };
  }

  /** Existe? Sem erro quando não existe. */
  async exists(path: string): Promise<boolean> {
    const out = await this.runRead(`if [ -e ${quote(path)} ]; then echo 1; else echo 0; fi`);
    return out.trim() === '1';
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const out = await this.runRead(
      [
        // Subshell: o `exit` e o `cd` não afetam o shell que fica aberto.
        `(cd -- ${quote(path)} || exit 1`,
        'for f in * .[!.]* ..?*; do',
        '  [ -e "$f" ] || [ -L "$f" ] || continue',
        '  if [ -d "$f" ]; then printf "d %s\\n" "$f";',
        '  elif [ -f "$f" ]; then printf "f %s\\n" "$f";',
        '  else printf "o %s\\n" "$f"; fi',
        'done)',
      ].join('\n'),
    );
    return out
      .split('\n')
      .filter((line) => line.length > 2)
      .map((line) => ({
        name: line.slice(2),
        kind: line.startsWith('d') ? 'dir' : line.startsWith('f') ? 'file' : 'other',
      }));
  }

  async read(path: string): Promise<Uint8Array> {
    const out = await this.runRead(`base64 < ${quote(path)}`);
    return new Uint8Array(Buffer.from(out.replace(/\s+/g, ''), 'base64'));
  }

  async write(path: string, content: Uint8Array): Promise<void> {
    const body = Buffer.from(content)
      .toString('base64')
      .replace(/.{1,76}/g, '$&\n');
    await this.run(`base64 -d > ${quote(path)} <<'__FAKL_FIM__'\n${body}__FAKL_FIM__`);
  }

  async mkdir(path: string): Promise<void> {
    await this.run(`mkdir -- ${quote(path)}`);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const p = quote(path);
    await this.run(
      recursive ? `rm -rf -- ${p}` : `if [ -d ${p} ]; then rmdir -- ${p}; else rm -f -- ${p}; fi`,
    );
  }

  async rename(from: string, to: string): Promise<void> {
    await this.run(`mv -f -- ${quote(from)} ${quote(to)}`);
  }
}
