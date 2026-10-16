/** Um host do `~/.ssh/config` (só blocos `Host` com nome exato, sem curingas). */
export interface SshConfigHost {
  readonly alias: string;
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly proxyJump?: string;
}

export interface ParsedSshConfig {
  readonly hosts: SshConfigHost[];
  /** Padrões de `Include`, na ordem em que aparecem. */
  readonly includes: string[];
}

/** Separa uma linha em palavra-chave e valor, aceitando `Chave valor` e `Chave=valor`. */
function splitLine(line: string): [string, string] | undefined {
  const match = /^\s*([A-Za-z]+)\s*(?:=\s*|\s+)(.*?)\s*$/.exec(line);
  if (!match?.[1] || match[2] === undefined) return undefined;
  let value = match[2];
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return [match[1].toLowerCase(), value];
}

function words(value: string): string[] {
  const out: string[] = [];
  for (const match of value.matchAll(/"([^"]*)"|(\S+)/g)) out.push(match[1] ?? match[2] ?? '');
  return out.filter(Boolean);
}

const isPattern = (alias: string): boolean => /[*?!]/.test(alias);

/**
 * Lê o texto de um `ssh_config` (SDD 11.2, somente leitura). Cada alias
 * exato de um bloco `Host` vira um host; valores de blocos `Host *` não são
 * herdados aqui, porque o próprio `ssh` os aplica ao conectar.
 */
export function parseSshConfig(text: string): ParsedSshConfig {
  const hosts = new Map<string, Record<string, string>>();
  const includes: string[] = [];
  let current: string[] = [];
  let inMatch = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const parts = splitLine(line);
    if (!parts) continue;
    const [key, value] = parts;
    if (key === 'host') {
      inMatch = false;
      current = words(value).filter((alias) => !isPattern(alias));
      for (const alias of current) if (!hosts.has(alias)) hosts.set(alias, {});
      continue;
    }
    if (key === 'match') {
      inMatch = true;
      current = [];
      continue;
    }
    if (key === 'include') {
      includes.push(...words(value));
      continue;
    }
    if (inMatch) continue;
    for (const alias of current) {
      const entry = hosts.get(alias);
      // Como no ssh, o primeiro valor de cada opção vale.
      if (entry && !(key in entry)) entry[key] = value;
    }
  }
  return {
    includes,
    hosts: [...hosts].map(([alias, options]): SshConfigHost => {
      const port = options.port ? Number(options.port) : undefined;
      return {
        alias,
        ...(options.hostname ? { hostname: options.hostname } : {}),
        ...(options.user ? { user: options.user } : {}),
        ...(port && Number.isInteger(port) ? { port } : {}),
        ...(options.identityfile ? { identityFile: options.identityfile } : {}),
        ...(options.proxyjump ? { proxyJump: options.proxyjump } : {}),
      };
    }),
  };
}
