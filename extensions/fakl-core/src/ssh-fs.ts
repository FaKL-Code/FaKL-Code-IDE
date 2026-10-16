import { l10n } from '@fakl/i18n';
import * as vscode from 'vscode';

import {
  RemoteError,
  RemoteShell,
  multiplexArgs,
  type RemoteKind,
  type RemoteStat,
} from './ssh-shell.js';
import { RemotePoller, type WatchEvent } from './ssh-watch.js';
import { SSH_SCHEME } from './ssh-workspace.js';

/*
 * Pasta remota nativa (RF-504): o explorador e o editor leem e gravam no
 * servidor por um `sh` aberto pelo ssh do sistema. Não instala nada no
 * servidor nem pede extensão. Endereço: `fakl-ssh://<alias>/<caminho>`.
 */

export { SSH_SCHEME };

/** Argumentos do ssh até o host (sem o comando), a partir do alias do endereço. */
export type TargetResolver = (alias: string) => Promise<string[]>;

/** Intervalo entre consultas de mudança nas pastas remotas. */
const POLL_MS = 5_000;

const SSH_OPTIONS = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=20',
  '-o',
  'StrictHostKeyChecking=accept-new',
  ...multiplexArgs(),
];

function fileType(kind: RemoteKind): vscode.FileType {
  return kind === 'dir'
    ? vscode.FileType.Directory
    : kind === 'file'
      ? vscode.FileType.File
      : vscode.FileType.Unknown;
}

/** Traduz o erro do shell para o que o VS Code espera de um sistema de arquivos. */
function fsError(error: unknown, uri: vscode.Uri): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/No such file|não existe|cannot stat|can't cd|can't open/i.test(text)) {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  if (
    /Permission denied \(publickey|Host key verification|Could not resolve|Connection (refused|timed out)/i.test(
      text,
    )
  ) {
    return vscode.FileSystemError.Unavailable(
      l10n.t(
        'SSH {0}: {1}. The remote folder uses an SSH key (no password); see "Generate SSH key".',
        uri.authority,
        text,
      ),
    );
  }
  if (/Permission denied|Operation not permitted|Read-only/i.test(text)) {
    return vscode.FileSystemError.NoPermissions(uri);
  }
  return vscode.FileSystemError.Unavailable(`SSH ${uri.authority}: ${text}`);
}

export class SshFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly shells = new Map<string, Promise<RemoteShell>>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  private readonly pollers = new Map<
    string,
    { poller: RemotePoller; skip: number; failures: number }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly resolve: TargetResolver) {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pollers.clear();
    for (const shell of this.shells.values())
      void shell.then((s) => {
        s.close();
      });
    this.shells.clear();
    this.emitter.dispose();
  }

  /** Fecha o shell de um host que saiu do workspace; a próxima leitura abre outro. */
  closeShell(alias: string): void {
    const shell = this.shells.get(alias);
    this.shells.delete(alias);
    void shell?.then((s) => {
      s.close();
    });
  }

  /** Shell do host do endereço; um por host, aberto na primeira vez. */
  shell(alias: string): Promise<RemoteShell> {
    let shell = this.shells.get(alias);
    if (!shell) {
      shell = this.resolve(alias).then(
        (target) => new RemoteShell({ command: 'ssh', args: [...SSH_OPTIONS, ...target, 'sh'] }),
      );
      this.shells.set(alias, shell);
    }
    return shell;
  }

  private async call<T>(uri: vscode.Uri, work: (shell: RemoteShell) => Promise<T>): Promise<T> {
    try {
      return await work(await this.shell(uri.authority));
    } catch (error) {
      throw fsError(error, uri);
    }
  }

  private changed(...events: vscode.FileChangeEvent[]): void {
    this.emitter.fire(events);
  }

  /**
   * O servidor não avisa mudanças: consulta a data de modificação das pastas e
   * arquivos observados a cada poucos segundos (só com a janela em foco), e
   * converte a diferença em eventos para o explorador e os editores.
   */
  watch(uri: vscode.Uri): vscode.Disposable {
    const alias = uri.authority;
    let entry = this.pollers.get(alias);
    if (!entry) {
      const emit = (events: WatchEvent[]): void => {
        this.changed(
          ...events.map((event) => ({
            type:
              event.type === 'created'
                ? vscode.FileChangeType.Created
                : event.type === 'deleted'
                  ? vscode.FileChangeType.Deleted
                  : vscode.FileChangeType.Changed,
            uri: uri.with({ path: event.path }),
          })),
        );
      };
      entry = {
        poller: new RemotePoller(
          {
            stat: async (path) => (await this.shell(alias)).stat(path),
            list: async (path) => (await this.shell(alias)).list(path),
          },
          emit,
        ),
        skip: 0,
        failures: 0,
      };
      this.pollers.set(alias, entry);
    }
    const stop = entry.poller.add(uri.path || '/');
    this.startTimer();
    return new vscode.Disposable(() => {
      stop();
      const current = this.pollers.get(alias);
      if (current?.poller.size === 0) this.pollers.delete(alias);
      if (this.pollers.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    });
  }

  private startTimer(): void {
    this.timer ??= setInterval(() => {
      if (!vscode.window.state.focused) return;
      for (const entry of this.pollers.values()) {
        // Depois de uma falha espera mais (até ~1 min) antes de reconectar.
        if (entry.skip > 0) {
          entry.skip--;
          continue;
        }
        void entry.poller.tick().then((ok) => {
          entry.failures = ok ? 0 : Math.min(entry.failures + 1, 5);
          entry.skip = ok ? 0 : 2 ** entry.failures;
        });
      }
    }, POLL_MS);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    let stat: RemoteStat;
    try {
      stat = await (await this.shell(uri.authority)).stat(uri.path || '/');
    } catch (error) {
      // `stat` que falha no shell vivo é arquivo que não existe.
      if (error instanceof RemoteError && !error.lost) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw fsError(error, uri);
    }
    return {
      type: fileType(stat.kind),
      size: stat.size,
      ctime: stat.mtime * 1000,
      mtime: stat.mtime * 1000,
    };
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.call(uri, async (shell) =>
      (await shell.list(uri.path || '/')).map((entry): [string, vscode.FileType] => [
        entry.name,
        fileType(entry.kind),
      ]),
    );
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.call(uri, (shell) => shell.read(uri.path));
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const exists = await this.call(uri, (shell) => shell.exists(uri.path));
    if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (exists && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    await this.call(uri, (shell) => shell.write(uri.path, content));
    this.changed({
      type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
      uri,
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.call(uri, (shell) => shell.mkdir(uri.path));
    this.changed({ type: vscode.FileChangeType.Created, uri });
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    await this.call(uri, (shell) => shell.remove(uri.path, options.recursive));
    this.changed({ type: vscode.FileChangeType.Deleted, uri });
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean },
  ): Promise<void> {
    if (!options.overwrite && (await this.call(newUri, (shell) => shell.exists(newUri.path)))) {
      throw vscode.FileSystemError.FileExists(newUri);
    }
    await this.call(oldUri, (shell) => shell.rename(oldUri.path, newUri.path));
    this.changed(
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    );
  }
}
