import type { CommandKind } from '@fakl/integrations';
import type { SshEntryKind } from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

/*
 * Operações de arquivo num host SSH para os agentes (ssh.read/write/list/stat).
 * Tudo vira um trecho de `sh` POSIX passado ao `ssh` como um único argumento;
 * por isso todo valor vindo do agente passa por `quote`/`remotePath`. O conteúdo
 * dos arquivos viaja em base64 (leitura pela saída, escrita pela entrada padrão).
 */

/** Teto de leitura e escrita por chamada. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_READ_BYTES = 1024 * 1024;
export const MAX_LIST_ENTRIES = 2000;

/**
 * Multiplexação de conexões (ControlMaster) para várias chamadas ao mesmo host.
 * O OpenSSH do Windows não implementa ControlMaster, então lá não se usa.
 */
export function multiplexArgs(platform: string = process.platform): string[] {
  if (platform === 'win32') return [];
  return [
    '-o',
    'ControlMaster=auto',
    // %C é um hash curto de usuário, host e porta: cabe no limite do caminho do socket.
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

/** Texto aceitável como caminho ou pasta: não vazio e sem NUL. */
export function checkPath(value: string, name: string): string {
  if (value.trim() === '') throw new Error(l10n.t('{0} cannot be empty', name));
  if (value.includes('\0')) throw new Error(l10n.t('{0} has an invalid character', name));
  return value;
}

/** Palavra de shell para um caminho: `~` e `~/x` valem a pasta pessoal do servidor. */
export function remotePath(path: string): string {
  if (path === '~') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"/${quote(path.slice(2))}`;
  return quote(path);
}

/** `cwd` opcional de `ssh.exec`: o comando roda na pasta, ou nem começa. */
export function withCwd(command: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return command;
  return `cd -- ${remotePath(checkPath(cwd, 'cwd'))} && {\n${command}\n}`;
}

export function readScript(path: string, maxBytes: number): string {
  // Um byte a mais mostra se o arquivo passou do limite.
  return `head -c ${String(Math.floor(maxBytes) + 1)} < ${remotePath(path)} | base64`;
}

export function writeScript(path: string, createDirs: boolean): string {
  const target = remotePath(path);
  const mk = createDirs ? `mkdir -p -- "$(dirname -- ${target})" && ` : '';
  return `${mk}base64 -d > ${target}`;
}

export function statScript(path: string): string {
  // GNU stat (Linux) primeiro; BSD stat (macOS, FreeBSD) não tem -c e responde com -f.
  // Nos dois casos sai "modo-em-hexa tamanho mtime".
  const target = remotePath(path);
  return `stat -L -c '%f %s %Y' -- ${target} 2>/dev/null || stat -L -f '%Xp %z %m' -- ${target}`;
}

export function listScript(path: string): string {
  return [
    `cd -- ${remotePath(path)} || exit 1`,
    'for f in * .[!.]* ..?*; do',
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    '  if [ -d "$f" ]; then printf "d %s\\n" "$f";',
    '  elif [ -f "$f" ]; then printf "f %s\\n" "$f";',
    '  else printf "o %s\\n" "$f"; fi',
    'done',
  ].join('\n');
}

export function encodeContent(content: string, encoding: 'utf8' | 'base64'): Buffer {
  if (encoding === 'base64') {
    const clean = content.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
      throw new Error(l10n.t('conteudo is not valid base64'));
    }
    return Buffer.from(clean, 'base64');
  }
  return Buffer.from(content, 'utf8');
}

/** Base64 de várias linhas, como o `base64` do servidor espera. */
export function toBase64Lines(data: Uint8Array): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/.{1,76}/g, '$&\n');
}

export function fromBase64(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

function utf8(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

export function decodeContent(
  data: Buffer,
  maxBytes: number,
): { conteudo: string; codificacao: 'utf8' | 'base64'; bytes: number; truncado: boolean } {
  const truncado = data.length > maxBytes;
  const slice = truncado ? data.subarray(0, maxBytes) : data;
  // O corte pode partir um caractere de vários bytes: tenta sem o fim.
  for (let cut = 0; cut <= (truncado ? 3 : 0); cut++) {
    const part = slice.subarray(0, slice.length - cut);
    const text = utf8(part);
    if (text !== undefined) {
      return { conteudo: text, codificacao: 'utf8', bytes: part.length, truncado };
    }
  }
  return {
    conteudo: slice.toString('base64'),
    codificacao: 'base64',
    bytes: slice.length,
    truncado,
  };
}

export function parseStat(
  output: string,
): { tipo: SshEntryKind; tamanho: number; modificadoEm: number } | undefined {
  const [mode, size, mtime] = output.trim().split(/\s+/);
  if (mode === undefined || size === undefined || mtime === undefined) return undefined;
  const type = Number.parseInt(mode, 16) & 0xf000;
  if (Number.isNaN(type)) return undefined;
  return {
    tipo: type === 0x4000 ? 'dir' : type === 0x8000 ? 'file' : 'other',
    tamanho: Number(size),
    modificadoEm: Number(mtime),
  };
}

export function parseList(output: string): { nome: string; tipo: SshEntryKind }[] {
  return output
    .split('\n')
    .filter((line) => line.length > 2 && line[1] === ' ')
    .map((line) => ({
      nome: line.slice(2),
      tipo: line.startsWith('d') ? 'dir' : line.startsWith('f') ? 'file' : 'other',
    }));
}

/** Caminhos que agentes não leem nem gravam por aqui: chaves e credenciais do SSH. */
export function isSensitivePath(path: string): boolean {
  return /(^|\/)\.ssh(\/|$)/.test(path) || path.endsWith('/etc/shadow');
}

export type RemoteOperation = 'read' | 'list' | 'stat' | 'write';

/** Risco de cada operação, para a política do host: ler é leitura, gravar é escrita. */
export function classifyOperation(operation: RemoteOperation): CommandKind {
  return operation === 'write' ? 'escrita' : 'leitura';
}
