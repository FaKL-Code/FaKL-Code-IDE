/** Política de um host para comandos de agentes (SDD 11.2). */
export const SSH_POLICIES = ['livre', 'confirmar', 'leitura', 'bloqueado'] as const;
export type SshPolicy = (typeof SSH_POLICIES)[number];

/** Natureza de um comando: só lê, escreve, ou pode destruir algo. */
export type CommandKind = 'leitura' | 'escrita' | 'destrutivo';

export type PolicyVerdict = 'executar' | 'confirmar' | 'recusar';

/** Comandos que só leem, em qualquer forma. */
const READ_COMMANDS = new Set([
  'ls',
  'll',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'wc',
  'du',
  'df',
  'free',
  'uptime',
  'uname',
  'hostname',
  'whoami',
  'id',
  'w',
  'who',
  'last',
  'ps',
  'top',
  'htop',
  'pgrep',
  'pwd',
  'echo',
  'printf',
  'date',
  'stat',
  'file',
  'which',
  'type',
  'env',
  'printenv',
  'journalctl',
  'dmesg',
  'lsblk',
  'lscpu',
  'lsof',
  'ss',
  'netstat',
  'ip',
  'ping',
  'dig',
  'nslookup',
  'host',
  'curl',
  'wget',
  'sort',
  'uniq',
  'cut',
  'awk',
  'jq',
  'tr',
  'column',
  'diff',
  'md5sum',
  'sha256sum',
  'tree',
  'true',
  'test',
  'nproc',
  'vmstat',
  'iostat',
]);

/** Comandos que só leem com certos subcomandos. */
const READ_SUBCOMMANDS: Record<string, readonly string[]> = {
  docker: ['ps', 'logs', 'images', 'inspect', 'stats', 'version', 'info', 'top', 'port'],
  'docker-compose': ['ps', 'logs', 'config', 'images', 'top'],
  podman: ['ps', 'logs', 'images', 'inspect', 'stats', 'version', 'info'],
  systemctl: [
    'status',
    'is-active',
    'is-enabled',
    'is-failed',
    'list-units',
    'list-timers',
    'show',
    'cat',
  ],
  git: ['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'blame'],
  kubectl: ['get', 'describe', 'logs', 'top', 'version', 'explain'],
  nginx: ['-t', '-T', '-v', '-V'],
  npm: ['ls', 'list', 'view', 'outdated', '-v', '--version'],
  pm2: ['ls', 'list', 'status', 'logs', 'show', 'describe'],
  apt: ['list', 'show', 'search', 'policy'],
  certbot: ['certificates'],
  ufw: ['status'],
};

/** Padrões que sempre pedem confirmação, qualquer que seja a política (SDD 14.3). */
const DESTRUCTIVE: readonly RegExp[] = [
  /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+|--recursive\s+|--force\s+)/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\s+[^|;&]*\bof=/,
  /\b(?:shutdown|reboot|poweroff|halt)\b/,
  /\binit\s+[06]\b/,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\s+(?:table\s+)?\w/i,
  /\bdelete\s+from\b/i,
  /\bgit\s+push\s+[^|;&]*(?:--force|-f\b|--delete|\s:)/,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f)/,
  /\bdocker\s+(?:system|volume|image|container|network)\s+prune\b/,
  /\bdocker\s+(?:rm|rmi|volume\s+rm)\b/,
  /\bdocker[- ]compose\s+down\s+[^|;&]*-v\b/,
  /\bkubectl\s+delete\b/,
  /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+\//,
  /\bchown\s+-R\s+\S+\s+\/(?:\s|$)/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  />\s*\/dev\/(?:sd|nvme|vd|xvd)/,
  /\bwipefs\b/,
  /\bfdisk\b|\bparted\b/,
  /\buserdel\b|\bdeluser\b/,
  /\biptables\s+-F\b|\bufw\s+(?:disable|reset)\b/,
];

/** Divide nos separadores de comando fora de aspas: ; & | && || e quebras de linha. */
export function splitCommands(command: string): { parts: string[]; risky: boolean } {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let risky = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && (ch === '`' || (ch === '$' && command[i + 1] === '(')))
        risky = true;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\') {
      current += ch + (command[i + 1] ?? '');
      i++;
      continue;
    }
    if (
      ch === '`' ||
      (ch === '$' && command[i + 1] === '(') ||
      (ch === '<' && command[i + 1] === '(')
    ) {
      risky = true;
    }
    if (ch === '>') {
      // Juntar saídas (2>&1) ou redirecionar para /dev/null não escreve nada.
      const dup = /^>&\d/.exec(command.slice(i));
      if (dup) {
        current += dup[0];
        i += dup[0].length - 1;
        continue;
      }
      const rest = command.slice(i + 1).replace(/^>?\s*/, '');
      if (!rest.startsWith('/dev/null')) risky = true;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return { parts, risky };
}

function firstWords(part: string): string[] {
  const tokens = part.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  // Pula atribuições de ambiente (FOO=bar comando).
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
  return tokens.slice(i).map((token) => token.replace(/^["']|["']$/g, ''));
}

function isReadOnly(part: string): boolean {
  const [name, ...args] = firstWords(part);
  if (!name) return true;
  const base = name.split('/').pop() ?? name;
  if (base === 'sudo' || base === 'su' || base === 'doas') return false;
  if (READ_COMMANDS.has(base)) {
    if (base === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir'))
      return false;
    if (
      (base === 'curl' || base === 'wget') &&
      args.some((a) => /^-(?:X|d|F|T|o|O)$|^--(?:data|upload|output|request|post)/.test(a))
    ) {
      return false;
    }
    if (base === 'awk' && args.some((a) => a.includes('system('))) return false;
    return true;
  }
  if (base === 'docker' && args[0] === 'compose')
    return READ_SUBCOMMANDS['docker-compose']?.includes(args[1] ?? '') ?? false;
  const allowed = READ_SUBCOMMANDS[base];
  if (!allowed) return false;
  const sub = args.find((a) => !a.startsWith('-') || allowed.includes(a));
  return sub !== undefined && allowed.includes(sub);
}

/** Classifica um comando de shell. Na dúvida, não é leitura. */
export function classifyCommand(command: string): CommandKind {
  if (DESTRUCTIVE.some((pattern) => pattern.test(command))) return 'destrutivo';
  const { parts, risky } = splitCommands(command);
  if (risky) return 'escrita';
  return parts.every(isReadOnly) ? 'leitura' : 'escrita';
}

/** O que fazer com um comando num host com esta política. */
export function policyVerdict(policy: SshPolicy, kind: CommandKind): PolicyVerdict {
  if (policy === 'bloqueado') return 'recusar';
  if (kind === 'destrutivo') return 'confirmar';
  if (policy === 'livre') return 'executar';
  if (policy === 'leitura') return kind === 'leitura' ? 'executar' : 'confirmar';
  return 'confirmar';
}
