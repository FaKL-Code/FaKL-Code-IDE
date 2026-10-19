import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import {
  classifyCommand,
  parseSshConfig,
  policyVerdict,
  SSH_POLICIES,
  type CommandKind,
  type SshConfigHost,
  type SshPolicy,
} from '@fakl/integrations';
import {
  FaklErrorCode,
  type SshExecResult,
  type SshHostInfo,
  type SshListResult,
  type SshReadResult,
  type SshStatResult,
  type SshWriteResult,
} from '@fakl/protocol';
import { l10n } from '@fakl/i18n';

import { run, type ExecResult } from '../exec.js';
import {
  objectParams,
  RpcError,
  stringParam,
  type CallContext,
  type Router,
} from '../rpc/router.js';
import type { AuditInput } from '../security/audit.js';
import { readJson, writeJsonAtomic } from '../store.js';
import { actorOf, isAgent, untrusted, type IntegrationGuards } from './guard.js';
import {
  buildForwardArgs,
  ForwardManager,
  parseForwardSpec,
  type ForwardOptions,
} from './ssh-forward.js';
import {
  checkPath,
  classifyOperation,
  decodeContent,
  DEFAULT_READ_BYTES,
  encodeContent,
  fromBase64,
  isSensitivePath,
  listScript,
  multiplexArgs,
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  parseList,
  parseStat,
  readScript,
  statScript,
  toBase64Lines,
  withCwd,
  writeScript,
  type RemoteOperation,
} from './ssh-remote.js';

/** O que o banco guarda de um host: os manuais inteiros, os do ~/.ssh/config só os ajustes. */
interface StoredHost {
  readonly alias: string;
  readonly origem: SshHostInfo['origem'];
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly grupos?: readonly string[];
  readonly tags?: readonly string[];
  readonly politica?: SshPolicy;
  readonly hostingerId?: number;
}

interface HostsFile {
  readonly hosts: StoredHost[];
}

export interface SshServiceOptions extends IntegrationGuards {
  /** Pasta pessoal, com o `.ssh/config`. */
  readonly home?: string;
  /** Arquivo dos hosts e políticas (em ~/.fakl/data). */
  readonly file?: string;
  /** Snapshot antes de escrita num VPS da Hostinger (RF-508). */
  readonly beforeWrite?: (
    host: SshHostInfo,
  ) => Promise<{ ok: true; id: string } | { ok: false; motivo: string }>;
  /** Tira segredos da saída antes de entregar ao agente. */
  readonly redact?: (text: string) => string;
  /** Executável do ssh; muda nos testes. */
  readonly sshCommand?: string;
  /**
   * Reaproveita a conexão entre chamadas do mesmo host (ControlMaster). Padrão:
   * ligado, menos no Windows, onde o OpenSSH não tem multiplexação.
   */
  readonly multiplex?: boolean;
  /** Quem roda o `ssh`; muda nos testes, que respondem como um servidor falso. */
  readonly runner?: typeof run;
  readonly log?: (message: string) => void;
  /** Arquivo dos encaminhamentos favoritos (em ~/.fakl/data). */
  readonly forwardsFile?: string;
  /** Mudança de estado de um encaminhamento de porta (evento `ssh.forward`). */
  readonly onForward?: ForwardOptions['emit'];
  /** Ajustes e dublês do gerenciador de encaminhamentos; os testes usam. */
  readonly forward?: Pick<
    ForwardOptions,
    'max' | 'spawn' | 'probe' | 'isFree' | 'retryDelayMs' | 'readyTimeoutMs'
  >;
}

const DEFAULT_POLICY: SshPolicy = 'confirmar';
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? value.map((v) => v.trim()).filter(Boolean)
    : undefined;
}

/** Expande `~` e caminhos relativos a ~/.ssh, como o ssh faz com Include. */
function sshPath(home: string, path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(home, path.slice(1));
  return isAbsolute(path) ? path : join(home, '.ssh', path);
}

async function expandInclude(home: string, pattern: string): Promise<string[]> {
  const path = sshPath(home, pattern);
  const name = basename(path);
  if (!/[*?]/.test(name)) return [path];
  const regex = new RegExp(
    `^${name
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );
  const dir = dirname(path);
  const entries = await readdir(dir).catch(() => []);
  return entries
    .filter((entry) => regex.test(entry))
    .sort()
    .map((entry) => join(dir, entry));
}

/** Lê o ~/.ssh/config e os Include dele (até 3 níveis), sem alterar nada. */
export async function readSshConfig(home: string): Promise<SshConfigHost[]> {
  const seen = new Set<string>();
  const hosts = new Map<string, SshConfigHost>();
  const visit = async (file: string, depth: number): Promise<void> => {
    if (depth > 3 || seen.has(file)) return;
    seen.add(file);
    const text = await readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) return;
    const parsed = parseSshConfig(text);
    for (const host of parsed.hosts) if (!hosts.has(host.alias)) hosts.set(host.alias, host);
    for (const include of parsed.includes) {
      for (const path of await expandInclude(home, include)) await visit(path, depth + 1);
    }
  };
  await visit(join(home, '.ssh', 'config'), 0);
  return [...hosts.values()];
}

/**
 * Gerenciador de SSH do Core (SDD 11.2): junta os hosts do ~/.ssh/config com
 * os da IDE e da Hostinger, guarda grupos, tags e a política de cada um, e
 * roda comandos pelo `ssh` do sistema (com o ssh-agent e o config do
 * usuário). Para agentes, a política decide: executa, pede aprovação ou recusa.
 */
export class SshService {
  private stored: StoredHost[] = [];
  private readonly home: string;
  private readonly forwards: ForwardManager;

  constructor(private readonly options: SshServiceOptions) {
    this.home = options.home ?? homedir();
    this.forwards = new ForwardManager({
      ...options.forward,
      resolve: async (spec) => ({
        command: options.sshCommand ?? 'ssh',
        args: buildForwardArgs(await this.host(spec.host), spec, (path) =>
          sshPath(this.home, path),
        ),
      }),
      ...(options.onForward ? { emit: options.onForward } : {}),
      ...(options.forwardsFile ? { file: options.forwardsFile } : {}),
      ...(options.redact ? { redact: options.redact } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  }

  async load(): Promise<void> {
    await this.forwards.load();
    if (!this.options.file) return;
    this.stored = (await readJson<HostsFile>(this.options.file))?.hosts ?? [];
  }

  /** Ao fechar o Core: encerra os `ssh -N -L` abertos. */
  async closeForwards(): Promise<void> {
    await this.forwards.dispose();
  }

  /**
   * Encaminhamento de porta (RF-504). Só a IDE e a CLI: agentes e aparelhos remotos são
   * recusados e a recusa vai para a auditoria. Abrir uma porta local para um servidor
   * não é algo que a política do host libere a um agente.
   */
  private async forwardGuard(action: string, context: CallContext, alvo: string): Promise<void> {
    if (context.principal === undefined) return;
    await this.options.audit.record({
      acao: `ssh.forward.${action}`,
      alvo,
      ator: actorOf(context),
      resultado: 'recusado',
    });
    throw new RpcError(
      FaklErrorCode.Forbidden,
      l10n.t('only the IDE manages port forwards; agents cannot'),
    );
  }

  async forwardList(context: CallContext): Promise<unknown> {
    await this.forwardGuard('list', context, '*');
    return this.forwards.list();
  }

  async forwardOpen(p: Record<string, unknown>, context: CallContext): Promise<unknown> {
    await this.forwardGuard('open', context, typeof p.host === 'string' ? p.host : '*');
    const spec = parseForwardSpec(p);
    const audit: AuditInput = {
      acao: 'ssh.forward.open',
      alvo: spec.host,
      ator: actorOf(context),
      resultado: 'ok',
      detalhes: {
        portaLocal: spec.portaLocal,
        destino: spec.destino,
        portaDestino: spec.portaDestino,
        reconectar: spec.reconectar,
      },
    };
    try {
      const info = await this.forwards.open(spec, p.favorito === true);
      await this.options.audit.record(audit);
      return info;
    } catch (error) {
      await this.options.audit.record({ ...audit, resultado: 'erro' });
      throw error;
    }
  }

  async forwardClose(p: Record<string, unknown>, context: CallContext): Promise<unknown> {
    const id = stringParam(p, 'id');
    await this.forwardGuard('close', context, id);
    const list = await this.forwards.close(id, p.esquecer === true);
    await this.options.audit.record({
      acao: 'ssh.forward.close',
      alvo: id,
      ator: actorOf(context),
      resultado: 'ok',
    });
    return list;
  }

  private async save(): Promise<void> {
    if (this.options.file) await writeJsonAtomic(this.options.file, { hosts: this.stored });
  }

  async hosts(): Promise<SshHostInfo[]> {
    const fromConfig = await readSshConfig(this.home);
    const byAlias = new Map(this.stored.map((h) => [h.alias, h]));
    const result: SshHostInfo[] = fromConfig.map((host) => {
      const extra = byAlias.get(host.alias);
      byAlias.delete(host.alias);
      return {
        ...host,
        origem: 'config',
        grupos: extra?.grupos ?? [],
        tags: extra?.tags ?? [],
        politica: extra?.politica ?? DEFAULT_POLICY,
        ...(extra?.hostingerId ? { hostingerId: extra.hostingerId } : {}),
      };
    });
    for (const host of byAlias.values()) {
      // Ajustes de um host que saiu do ~/.ssh/config não viram host.
      if (host.origem === 'config') continue;
      result.push({
        alias: host.alias,
        origem: host.origem,
        ...(host.hostname ? { hostname: host.hostname } : {}),
        ...(host.user ? { user: host.user } : {}),
        ...(host.port ? { port: host.port } : {}),
        ...(host.identityFile ? { identityFile: host.identityFile } : {}),
        grupos: host.grupos ?? [],
        tags: host.tags ?? [],
        politica: host.politica ?? DEFAULT_POLICY,
        ...(host.hostingerId ? { hostingerId: host.hostingerId } : {}),
      });
    }
    return result.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  async host(alias: string): Promise<SshHostInfo> {
    const host = (await this.hosts()).find((h) => h.alias === alias);
    if (!host) throw RpcError.notFound(l10n.t('host {0} does not exist in the SSH manager', alias));
    return host;
  }

  /** Cria ou ajusta um host. Num host do ~/.ssh/config, só grupos, tags e política mudam. */
  async upsert(p: Record<string, unknown>): Promise<SshHostInfo> {
    const alias = stringParam(p, 'alias');
    if (!ALIAS.test(alias))
      throw RpcError.invalidParams(l10n.t('alias: letters, numbers, dot, hyphen and _'));
    const politica = p.politica;
    if (politica !== undefined && !SSH_POLICIES.includes(politica as SshPolicy)) {
      throw RpcError.invalidParams(l10n.t('politica must be {0}', SSH_POLICIES.join(', ')));
    }
    const fromConfig = (await readSshConfig(this.home)).some((h) => h.alias === alias);
    const index = this.stored.findIndex((h) => h.alias === alias);
    const previous = this.stored[index];
    const origem: SshHostInfo['origem'] = fromConfig ? 'config' : (previous?.origem ?? 'manual');
    const port = typeof p.port === 'number' && Number.isInteger(p.port) ? p.port : previous?.port;
    const hostname = typeof p.hostname === 'string' && p.hostname ? p.hostname : previous?.hostname;
    if (origem !== 'config' && !hostname)
      throw RpcError.invalidParams(l10n.t('hostname is required'));
    const user = typeof p.user === 'string' && p.user ? p.user : previous?.user;
    const identityFile =
      typeof p.identityFile === 'string' && p.identityFile
        ? p.identityFile
        : previous?.identityFile;
    const grupos = strings(p.grupos) ?? previous?.grupos;
    const tags = strings(p.tags) ?? previous?.tags;
    const hostingerId = typeof p.hostingerId === 'number' ? p.hostingerId : previous?.hostingerId;
    const next: StoredHost = {
      alias,
      origem,
      ...(origem !== 'config' && hostname ? { hostname } : {}),
      ...(origem !== 'config' && user ? { user } : {}),
      ...(origem !== 'config' && port ? { port } : {}),
      ...(origem !== 'config' && identityFile ? { identityFile } : {}),
      ...(grupos ? { grupos } : {}),
      ...(tags ? { tags } : {}),
      ...(politica
        ? { politica: politica as SshPolicy }
        : previous?.politica
          ? { politica: previous.politica }
          : {}),
      ...(hostingerId ? { hostingerId } : {}),
    };
    if (index >= 0) this.stored[index] = next;
    else this.stored.push(next);
    await this.save();
    return this.host(alias);
  }

  async remove(alias: string): Promise<void> {
    const before = this.stored.length;
    this.stored = this.stored.filter((h) => h.alias !== alias || h.origem === 'config');
    if (this.stored.length === before) {
      throw RpcError.invalidParams(
        l10n.t('only hosts created by the IDE or by Hostinger can be removed'),
      );
    }
    await this.save();
  }

  /** VPS da Hostinger entram como hosts (RF-507), sem perder ajustes já feitos. */
  async syncHostinger(
    vps: readonly { id: number; hostname: string; address: string | undefined }[],
  ): Promise<void> {
    let changed = false;
    for (const machine of vps) {
      const address = machine.address;
      if (!address) continue;
      const existing = this.stored.find((h) => h.hostingerId === machine.id);
      if (existing) {
        if (existing.origem === 'hostinger' && existing.hostname !== address) {
          this.stored = this.stored.map((h) => (h === existing ? { ...h, hostname: address } : h));
          changed = true;
        }
        continue;
      }
      const base = `hostinger-${machine.hostname.split('.')[0] ?? String(machine.id)}`
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .slice(0, 60);
      let alias = base;
      for (let n = 2; this.stored.some((h) => h.alias === alias); n++)
        alias = `${base}-${String(n)}`;
      this.stored.push({
        alias,
        origem: 'hostinger',
        hostname: address,
        user: 'root',
        hostingerId: machine.id,
        politica: DEFAULT_POLICY,
        tags: ['hostinger'],
      });
      changed = true;
    }
    if (changed) await this.save();
  }

  /** Argumentos do `ssh`: hosts do config pelo alias, os outros por endereço. */
  sshArgs(host: SshHostInfo, command: string): string[] {
    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      ...(this.options.multiplex === false ? [] : multiplexArgs()),
    ];
    if (host.origem === 'config') return [...args, host.alias, '--', command];
    return [
      ...args,
      '-o',
      'StrictHostKeyChecking=accept-new',
      ...(host.port ? ['-p', String(host.port)] : []),
      ...(host.user ? ['-l', host.user] : []),
      ...(host.identityFile ? ['-i', sshPath(this.home, host.identityFile)] : []),
      host.hostname ?? host.alias,
      '--',
      command,
    ];
  }

  /**
   * Política, aprovação e snapshot de uma ação de agente num host (SDD 11.2).
   * A IDE e a CLI não passam por aqui. Devolve o snapshot da Hostinger, se houve.
   */
  private async authorize(
    host: SshHostInfo,
    kind: CommandKind,
    context: CallContext,
    audit: AuditInput,
    describe: (extra: string) => string,
  ): Promise<string | undefined> {
    const agent = isAgent(context) && context.principal ? context.principal : undefined;
    if (!agent) return undefined;
    const verdict = policyVerdict(host.politica, kind);
    if (verdict === 'recusar') {
      await this.options.audit.record({ ...audit, ator: agent, resultado: 'recusado' });
      throw new RpcError(
        FaklErrorCode.Forbidden,
        l10n.t('host {0} is blocked for agents', host.alias),
      );
    }
    const needsSnapshot = host.origem === 'hostinger' || host.hostingerId !== undefined;
    const ask = async (extra: string): Promise<void> => {
      const allowed = await this.options.approvals.request({
        sessionId: agent,
        titulo: describe(extra),
      });
      if (!allowed) {
        await this.options.audit.record({ ...audit, ator: agent, resultado: 'negado' });
        throw new RpcError(FaklErrorCode.Forbidden, l10n.t('the user denied this action'));
      }
    };
    if (verdict === 'confirmar') {
      await ask(needsSnapshot && kind !== 'leitura' ? l10n.t('; snapshot first') : '');
      await this.options.audit.record({ ...audit, ator: agent, resultado: 'aprovado' });
    }
    if (needsSnapshot && kind !== 'leitura' && this.options.beforeWrite) {
      const result = await this.options.beforeWrite(host);
      if (result.ok) return result.id;
      // Sem snapshot, a ação volta a pedir aprovação (SDD 11.3).
      await ask(l10n.t('; the snapshot failed: {0}', result.motivo));
    }
    return undefined;
  }

  private clean(host: SshHostInfo, context: CallContext, text: string): string {
    const redacted = this.options.redact?.(text) ?? text;
    return isAgent(context) && redacted
      ? untrusted(l10n.t('output from {0}', host.alias), redacted)
      : redacted;
  }

  async exec(p: Record<string, unknown>, context: CallContext): Promise<SshExecResult> {
    const host = await this.host(stringParam(p, 'host'));
    const command = stringParam(p, 'comando');
    const cwd = typeof p.cwd === 'string' && p.cwd !== '' ? p.cwd : undefined;
    let script: string;
    try {
      script = withCwd(command, cwd);
    } catch (error) {
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
    const timeoutMs =
      typeof p.timeoutSeg === 'number' && p.timeoutSeg > 0
        ? Math.min(p.timeoutSeg, 1800) * 1000
        : 120_000;
    const kind: CommandKind = classifyCommand(command);
    const audit: AuditInput = {
      acao: 'ssh.exec',
      alvo: host.alias,
      ator: actorOf(context),
      resultado: 'ok',
      detalhes: { comando: command, tipo: kind, politica: host.politica, ...(cwd ? { cwd } : {}) },
    };
    const snapshot = await this.authorize(host, kind, context, audit, (extra) =>
      cwd
        ? l10n.t('Run on {0} (in {1}) ({2}{3}):\n{4}', host.alias, cwd, kind, extra, command)
        : l10n.t('Run on {0} ({1}{2}):\n{3}', host.alias, kind, extra, command),
    );
    const started = Date.now();
    const result = await (this.options.runner ?? run)(
      this.options.sshCommand ?? 'ssh',
      this.sshArgs(host, script),
      {
        cwd: this.home,
        timeoutMs,
        tailChars: 20_000,
      },
    );
    const duracaoMs = Date.now() - started;
    await this.options.audit.record({
      ...audit,
      resultado: result.code === 0 ? 'ok' : 'erro',
      detalhes: { ...audit.detalhes, codigo: result.code, ...(snapshot ? { snapshot } : {}) },
    });
    return {
      codigo: result.code,
      saida: this.clean(host, context, result.stdout),
      erro: this.clean(host, context, result.stderr),
      duracaoMs,
      ...(snapshot ? { snapshot } : {}),
    };
  }

  /**
   * Operação de arquivo num host, na mesma trilha do `exec`: política do host,
   * aprovação, snapshot da Hostinger (só escrita) e auditoria. Agentes não
   * acessam ~/.ssh nem /etc/shadow por aqui.
   */
  private async fileOp(
    operation: RemoteOperation,
    p: Record<string, unknown>,
    context: CallContext,
    script: (path: string) => string,
    input?: string,
    detalhes: Record<string, unknown> = {},
  ): Promise<{ host: SshHostInfo; result: ExecResult; snapshot?: string }> {
    const host = await this.host(stringParam(p, 'host'));
    const path = stringParam(p, 'caminho');
    try {
      checkPath(path, 'caminho');
    } catch (error) {
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
    const kind = classifyOperation(operation);
    const audit: AuditInput = {
      acao: `ssh.${operation}`,
      alvo: host.alias,
      ator: actorOf(context),
      resultado: 'ok',
      detalhes: { caminho: path, tipo: kind, politica: host.politica, ...detalhes },
    };
    if (isAgent(context) && isSensitivePath(path)) {
      await this.options.audit.record({
        ...audit,
        resultado: 'recusado',
        detalhes: { ...audit.detalhes, motivo: l10n.t('sensitive path') },
      });
      throw new RpcError(
        FaklErrorCode.Forbidden,
        l10n.t('agents cannot access ~/.ssh or server credentials'),
      );
    }
    const snapshot = await this.authorize(host, kind, context, audit, (extra) =>
      operation === 'write'
        ? l10n.t('Write to {0} ({1}{2}):\n{3}', host.alias, operation, extra, path)
        : l10n.t('Read from {0} ({1}{2}):\n{3}', host.alias, operation, extra, path),
    );
    const result = await (this.options.runner ?? run)(
      this.options.sshCommand ?? 'ssh',
      this.sshArgs(host, script(path)),
      {
        cwd: this.home,
        timeoutMs: 60_000,
        tailChars: MAX_FILE_BYTES * 2,
        ...(input !== undefined ? { input } : {}),
      },
    );
    await this.options.audit.record({
      ...audit,
      resultado: result.code === 0 ? 'ok' : 'erro',
      detalhes: { ...audit.detalhes, codigo: result.code, ...(snapshot ? { snapshot } : {}) },
    });
    return { host, result, ...(snapshot ? { snapshot } : {}) };
  }

  private fail(host: SshHostInfo, context: CallContext, result: ExecResult): never {
    const text = (result.stderr || result.stdout).trim() || l10n.t('code {0}', String(result.code));
    throw RpcError.invalidParams(this.clean(host, context, text));
  }

  async read(p: Record<string, unknown>, context: CallContext): Promise<SshReadResult> {
    const limit =
      typeof p.maxBytes === 'number' && p.maxBytes > 0
        ? Math.min(Math.floor(p.maxBytes), MAX_FILE_BYTES)
        : DEFAULT_READ_BYTES;
    const { host, result } = await this.fileOp('read', p, context, (path) =>
      readScript(path, limit),
    );
    if (result.code !== 0) this.fail(host, context, result);
    const decoded = decodeContent(fromBase64(result.stdout), limit);
    // Só texto passa por redação e marcação de conteúdo externo.
    return decoded.codificacao === 'utf8'
      ? { ...decoded, conteudo: this.clean(host, context, decoded.conteudo) }
      : decoded;
  }

  async write(p: Record<string, unknown>, context: CallContext): Promise<SshWriteResult> {
    const encoding = p.codificacao === 'base64' ? 'base64' : 'utf8';
    let data: Buffer;
    try {
      data = encodeContent(stringParam(p, 'conteudo'), encoding);
    } catch (error) {
      throw RpcError.invalidParams(error instanceof Error ? error.message : String(error));
    }
    if (data.length > MAX_FILE_BYTES) {
      throw RpcError.invalidParams(l10n.t('conteudo exceeds {0} bytes', String(MAX_FILE_BYTES)));
    }
    const { host, result, snapshot } = await this.fileOp(
      'write',
      p,
      context,
      (path) => writeScript(path, p.criarPastas === true),
      toBase64Lines(data),
      { bytes: data.length },
    );
    if (result.code !== 0) this.fail(host, context, result);
    return { bytes: data.length, ...(snapshot ? { snapshot } : {}) };
  }

  async list(p: Record<string, unknown>, context: CallContext): Promise<SshListResult> {
    const { host, result } = await this.fileOp('list', p, context, listScript);
    if (result.code !== 0) this.fail(host, context, result);
    const all = parseList(result.stdout);
    return {
      entradas: all.slice(0, MAX_LIST_ENTRIES).map((e) => ({
        nome: this.options.redact?.(e.nome) ?? e.nome,
        tipo: e.tipo,
      })),
      truncado: all.length > MAX_LIST_ENTRIES,
    };
  }

  async stat(p: Record<string, unknown>, context: CallContext): Promise<SshStatResult> {
    const { host, result } = await this.fileOp('stat', p, context, statScript);
    if (result.code !== 0) {
      if (/No such file|cannot stat/i.test(result.stderr)) return { existe: false };
      this.fail(host, context, result);
    }
    const parsed = parseStat(result.stdout);
    return parsed ? { existe: true, ...parsed } : { existe: false };
  }

  register(router: Router): void {
    router.register('ssh.hosts.list', () => this.hosts());
    router.register('ssh.hosts.upsert', (params) => this.upsert(objectParams(params)));
    router.register('ssh.hosts.delete', async (params) => {
      await this.remove(stringParam(objectParams(params), 'alias'));
      return null;
    });
    router.register('ssh.exec', (params, context) => this.exec(objectParams(params), context));
    router.register('ssh.read', (params, context) => this.read(objectParams(params), context));
    router.register('ssh.write', (params, context) => this.write(objectParams(params), context));
    router.register('ssh.list', (params, context) => this.list(objectParams(params), context));
    router.register('ssh.stat', (params, context) => this.stat(objectParams(params), context));
    router.register('ssh.forward.list', (_params, context) => this.forwardList(context));
    router.register('ssh.forward.open', (params, context) =>
      this.forwardOpen(objectParams(params), context),
    );
    router.register('ssh.forward.close', (params, context) =>
      this.forwardClose(objectParams(params), context),
    );
  }
}
