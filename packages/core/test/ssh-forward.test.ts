import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SshForwardInfo, SshHostInfo } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventBus } from '../src/events/bus.js';
import { SshService } from '../src/integrations/ssh.js';
import {
  buildForwardArgs,
  ForwardManager,
  parseForwardSpec,
  parsePort,
  type ForwardSpec,
} from '../src/integrations/ssh-forward.js';
import type { CallContext } from '../src/rpc/router.js';
import { Approvals } from '../src/security/approvals.js';
import { AuditLog } from '../src/security/audit.js';

function context(principal?: string): CallContext {
  return { connectionId: 'c', principal, notify: () => undefined, onClose: () => undefined };
}

const spec: ForwardSpec = {
  host: 'vps',
  portaLocal: 8080,
  destino: '127.0.0.1',
  portaDestino: 5432,
  reconectar: false,
};

const configHost: SshHostInfo = {
  alias: 'vps',
  origem: 'config',
  grupos: [],
  tags: [],
  politica: 'confirmar',
};

const manualHost: SshHostInfo = {
  alias: 'srv',
  origem: 'manual',
  hostname: '203.0.113.10',
  user: 'deploy',
  port: 2222,
  identityFile: '/keys/id',
  grupos: [],
  tags: [],
  politica: 'confirmar',
};

describe('argumentos do ssh -L', () => {
  it('host do ~/.ssh/config: pelo alias, bind em 127.0.0.1 e sem shell', () => {
    expect(buildForwardArgs(configHost, spec)).toEqual([
      '-N',
      '-T',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-L',
      '127.0.0.1:8080:127.0.0.1:5432',
      '--',
      'vps',
    ]);
  });

  it('host manual: porta, usuário e chave; o destino do ssh vem depois de --', () => {
    const args = buildForwardArgs(manualHost, { ...spec, host: 'srv', destino: 'db.interno' });
    expect(args).toContain('127.0.0.1:8080:db.interno:5432');
    expect(args.slice(-8)).toEqual([
      '-p',
      '2222',
      '-l',
      'deploy',
      '-i',
      '/keys/id',
      '--',
      '203.0.113.10',
    ]);
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    // O bind nunca muda para outra interface.
    expect(args.filter((a) => /^[^:]*:\d+:/.test(a))).toEqual(['127.0.0.1:8080:db.interno:5432']);
  });

  it('recusa host, usuário ou endereço que viraria opção do ssh', () => {
    const hostile = [
      { ...manualHost, hostname: '-oProxyCommand=touch /tmp/pwn' },
      { ...manualHost, hostname: 'a b' },
      { ...manualHost, hostname: 'a;rm -rf /' },
      { ...manualHost, hostname: '$(id)' },
      { ...manualHost, hostname: undefined },
      { ...manualHost, user: '-oProxyCommand=x' },
      { ...manualHost, user: 'a b' },
      { ...manualHost, port: -1 },
      { ...configHost, alias: '-oProxyCommand=x' },
      { ...configHost, alias: 'a b' },
    ] as SshHostInfo[];
    for (const host of hostile) {
      expect(() => buildForwardArgs(host, spec), JSON.stringify(host)).toThrow();
    }
  });

  it('valida portas numéricas de 1 a 65535', () => {
    expect(parsePort(1, 'p')).toBe(1);
    expect(parsePort(65_535, 'p')).toBe(65_535);
    expect(parsePort('8080', 'p')).toBe(8080);
    for (const bad of [
      0,
      65_536,
      -1,
      1.5,
      '80; rm -rf /',
      '0x50',
      ' 80',
      '',
      null,
      undefined,
      NaN,
    ]) {
      expect(() => parsePort(bad, 'portaLocal'), String(bad)).toThrow('portaLocal');
    }
  });

  it('valida o pedido: host do inventário, destino e reconectar', () => {
    const ok = parseForwardSpec({ host: 'vps', portaLocal: 8080, portaDestino: '5432' });
    expect(ok).toEqual({ ...spec, reconectar: false });
    expect(parseForwardSpec({ ...ok, destino: '[::1]', reconectar: true })).toMatchObject({
      destino: '[::1]',
      reconectar: true,
    });
    const base = { host: 'vps', portaLocal: 8080, portaDestino: 80 };
    for (const destino of ['a b', '-oX=1', '$(id)', 'a;b', 'db:80', 'user@db', 'a/b', '[::1', 5]) {
      expect(() => parseForwardSpec({ ...base, destino }), String(destino)).toThrow('destino');
    }
    for (const host of ['', 'a b', '-x', 'a;b', 1, undefined]) {
      expect(() => parseForwardSpec({ ...base, host }), String(host)).toThrow('host');
    }
    expect(() => parseForwardSpec({ ...base, reconectar: 'sim' })).toThrow('reconectar');
  });
});

/** Processo falso: o teste decide quando ele cai. */
class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  killed: string[] = [];
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
  crash(code: number, stderr = ''): void {
    if (stderr) this.stderr.emit('data', Buffer.from(stderr));
    this.emit('exit', code, null);
  }
}

describe('ciclo de vida dos encaminhamentos', () => {
  let dir: string;
  let children: FakeChild[];
  let spawned: { command: string; args: readonly string[] }[];
  let events: SshForwardInfo[];
  let probeUp: boolean;
  let free: boolean;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-fwd-'));
    children = [];
    spawned = [];
    events = [];
    probeUp = true;
    free = true;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function manager(
    over: Partial<ConstructorParameters<typeof ForwardManager>[0]> = {},
  ): ForwardManager {
    return new ForwardManager({
      resolve: (s) => Promise.resolve({ command: 'ssh', args: buildForwardArgs(configHost, s) }),
      emit: (info) => events.push(info),
      spawn: (command, args) => {
        spawned.push({ command, args });
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      probe: () => Promise.resolve(probeUp),
      isFree: () => Promise.resolve(free),
      retryDelayMs: () => 1,
      readyTimeoutMs: 400,
      ...over,
    });
  }

  it('abre, fica ativo, lista e fecha encerrando o processo', async () => {
    const forwards = manager();
    const info = await forwards.open(spec, false);
    expect(info).toMatchObject({
      id: 'vps:8080',
      estado: 'ativo',
      bind: '127.0.0.1',
      url: 'http://127.0.0.1:8080',
      favorito: false,
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toContain('127.0.0.1:8080:127.0.0.1:5432');
    expect(events.map((e) => e.estado)).toEqual(['abrindo', 'ativo']);
    expect(forwards.list().map((f) => f.estado)).toEqual(['ativo']);

    const left = await forwards.close('vps:8080', false);
    expect(left).toEqual([]);
    expect(children[0]?.killed).toEqual(['SIGTERM']);
    expect(events.at(-1)?.estado).toBe('fechado');
    await expect(forwards.close('vps:8080', false)).rejects.toThrow('não existe');
  });

  it('respeita o limite de simultâneos e não repete a porta local', async () => {
    const forwards = manager({ max: 2 });
    await forwards.open(spec, false);
    await forwards.open({ ...spec, portaLocal: 8081 }, false);
    await expect(forwards.open({ ...spec, portaLocal: 8082 }, false)).rejects.toThrow(
      'no máximo 2',
    );
    await expect(forwards.open({ ...spec, host: 'outro' }, false)).rejects.toThrow('já');
    await expect(forwards.open(spec, false)).rejects.toThrow('já');
    expect(spawned).toHaveLength(2);
    // Fechar um libera a vaga.
    await forwards.close('vps:8081', false);
    await forwards.open({ ...spec, portaLocal: 8082 }, false);
    expect(spawned).toHaveLength(3);
  });

  it('porta local ocupada na máquina: recusa sem iniciar o ssh', async () => {
    free = false;
    await expect(manager().open(spec, false)).rejects.toThrow('em uso');
    expect(spawned).toHaveLength(0);
  });

  it('falha na primeira tentativa vira erro com o texto do ssh e não deixa item parado', async () => {
    const forwards = manager();
    probeUp = false;
    const opening = forwards.open(spec, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    children[0]?.crash(255, 'bind [127.0.0.1]:8080: Address already in use');
    await expect(opening).rejects.toThrow('código 255');
    expect(forwards.list()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ estado: 'erro' });
    expect(events.at(-1)?.erro).toContain('Address already in use');
  });

  it('o ssh que não abre a porta no prazo é encerrado', async () => {
    const forwards = manager({ readyTimeoutMs: 60 });
    probeUp = false;
    await expect(forwards.open(spec, false)).rejects.toThrow('prazo');
    expect(children[0]?.killed).toEqual(['SIGTERM']);
    expect(forwards.list()).toEqual([]);
  });

  it('sem reconexão, a queda vira erro; com reconexão, abre de novo', async () => {
    const plain = manager();
    await plain.open(spec, false);
    children[0]?.crash(255, 'Connection reset');
    expect(plain.list()[0]).toMatchObject({ estado: 'erro' });
    expect(plain.list()[0]?.erro).toContain('Connection reset');
    expect(spawned).toHaveLength(1);
    // Um item com erro pode ser aberto de novo e some ao fechar.
    await plain.open(spec, false);
    expect(plain.list()[0]?.estado).toBe('ativo');
    await plain.dispose();

    children.length = 0;
    spawned.length = 0;
    const again = manager();
    await again.open({ ...spec, reconectar: true }, false);
    children[0]?.crash(255);
    expect(again.list()[0]).toMatchObject({ estado: 'reconectando', tentativas: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(spawned).toHaveLength(2);
    expect(again.list()[0]).toMatchObject({ estado: 'ativo', tentativas: 0 });
    await again.dispose();
  });

  it('a reconexão desiste depois de algumas quedas seguidas', async () => {
    const forwards = manager();
    await forwards.open({ ...spec, reconectar: true }, false);
    probeUp = false;
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      children.at(-1)?.crash(255, 'sem rota');
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forwards.list()[0]).toMatchObject({ estado: 'erro' });
    expect(spawned.length).toBe(6);
    await forwards.dispose();
  });

  it('fechar durante a reconexão cancela a nova tentativa', async () => {
    const forwards = manager({ retryDelayMs: () => 100 });
    await forwards.open({ ...spec, reconectar: true }, false);
    children[0]?.crash(255);
    await forwards.close('vps:8080', false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(spawned).toHaveLength(1);
    expect(forwards.list()).toEqual([]);
  });

  it('dispose encerra todos os processos e recusa novos', async () => {
    const forwards = manager();
    await forwards.open(spec, false);
    await forwards.open({ ...spec, portaLocal: 8081 }, false);
    await forwards.dispose();
    expect(children.map((c) => c.killed)).toEqual([['SIGTERM'], ['SIGTERM']]);
    expect(forwards.list()).toEqual([]);
    await expect(forwards.open(spec, false)).rejects.toThrow();
  });

  it('favoritos: guardados em arquivo, listados fechados e nunca reabertos sozinhos', async () => {
    const file = join(dir, 'ssh-forwards.json');
    const first = manager({ file });
    const info = await first.open({ ...spec, reconectar: true }, true);
    expect(info.favorito).toBe(true);
    await first.dispose();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      favoritos: [
        {
          host: 'vps',
          portaLocal: 8080,
          destino: '127.0.0.1',
          portaDestino: 5432,
          reconectar: true,
        },
      ],
    });

    spawned.length = 0;
    const second = manager({ file });
    await second.load();
    expect(second.list()).toMatchObject([
      { id: 'vps:8080', estado: 'fechado', favorito: true, reconectar: true },
    ]);
    expect(spawned).toHaveLength(0);

    // Esquecer o favorito tira da lista e do arquivo.
    await second.close('vps:8080', true);
    expect(second.list()).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ favoritos: [] });
  });

  it('favoritos corrompidos no arquivo são ignorados', async () => {
    const file = join(dir, 'ssh-forwards.json');
    await writeFile(
      file,
      JSON.stringify({
        favoritos: [
          { host: '-x', portaLocal: 80, destino: 'a', portaDestino: 80, reconectar: false },
          { host: 'vps', portaLocal: 70_000, destino: 'a', portaDestino: 80, reconectar: false },
          { host: 'vps', portaLocal: 80, destino: 'a', portaDestino: 80, reconectar: false },
        ],
      }),
    );
    const forwards = manager({ file });
    await forwards.load();
    expect(forwards.list().map((f) => f.id)).toEqual(['vps:80']);
  });
});

describe('SshService: encaminhamento de porta', () => {
  let dir: string;
  let audit: AuditLog;
  let service: SshService;
  let spawned: string[][];
  let events: SshForwardInfo[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-fwdsvc-'));
    await mkdir(join(dir, 'home', '.ssh'), { recursive: true });
    await writeFile(
      join(dir, 'home', '.ssh', 'config'),
      'Host vps\n  HostName 203.0.113.10\n  User deploy\n',
    );
    audit = new AuditLog(join(dir, 'audit.jsonl'));
    spawned = [];
    events = [];
    service = new SshService({
      approvals: new Approvals(new EventBus()),
      audit,
      home: join(dir, 'home'),
      file: join(dir, 'hosts.json'),
      forwardsFile: join(dir, 'forwards.json'),
      sshCommand: 'ssh-falso',
      onForward: (info) => events.push(info),
      forward: {
        spawn: (_command, args) => {
          spawned.push([...args]);
          return new FakeChild();
        },
        probe: () => Promise.resolve(true),
        isFree: () => Promise.resolve(true),
      },
    });
    await service.load();
  });

  afterEach(async () => {
    await service.closeForwards();
    await rm(dir, { recursive: true, force: true });
  });

  async function auditEntries(): Promise<{ acao: string; ator: string; resultado: string }[]> {
    await audit.verify();
    const text = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { acao: string; ator: string; resultado: string });
  }

  it('a IDE abre o encaminhamento de um host do inventário e a auditoria registra', async () => {
    const open = (await service.forwardOpen(
      { host: 'vps', portaLocal: 8080, portaDestino: 5432, favorito: true },
      context(),
    )) as SshForwardInfo;
    expect(open).toMatchObject({ id: 'vps:8080', estado: 'ativo', favorito: true });
    expect(spawned[0]?.slice(-3)).toEqual(['127.0.0.1:8080:127.0.0.1:5432', '--', 'vps']);
    expect(events.map((e) => e.estado)).toEqual(['abrindo', 'ativo']);
    expect(((await service.forwardList(context())) as SshForwardInfo[]).length).toBe(1);
    await service.forwardClose({ id: 'vps:8080' }, context());
    expect(await auditEntries()).toMatchObject([
      { acao: 'ssh.forward.open', ator: 'ide', resultado: 'ok' },
      { acao: 'ssh.forward.close', ator: 'ide', resultado: 'ok' },
    ]);
  });

  it('host que não está no inventário é recusado antes de iniciar o ssh', async () => {
    await expect(
      service.forwardOpen({ host: 'fantasma', portaLocal: 8080, portaDestino: 80 }, context()),
    ).rejects.toThrow('não existe');
    await expect(
      service.forwardOpen({ host: 'vps', portaLocal: 8080, portaDestino: 99_999 }, context()),
    ).rejects.toThrow('portaDestino');
    await expect(
      service.forwardOpen(
        { host: 'vps', portaLocal: 8080, portaDestino: 80, destino: '-oProxyCommand=x' },
        context(),
      ),
    ).rejects.toThrow('destino');
    expect(spawned).toHaveLength(0);
  });

  it('agentes e aparelhos remotos não abrem, fecham nem listam encaminhamentos', async () => {
    for (const principal of ['sessao-1', 'remote:celular']) {
      await expect(
        service.forwardOpen(
          { host: 'vps', portaLocal: 8080, portaDestino: 80 },
          context(principal),
        ),
      ).rejects.toThrow('só a IDE');
      await expect(service.forwardClose({ id: 'vps:8080' }, context(principal))).rejects.toThrow(
        'só a IDE',
      );
      await expect(service.forwardList(context(principal))).rejects.toThrow('só a IDE');
    }
    expect(spawned).toHaveLength(0);
    // Mesmo num host com política livre, o agente continua sem acesso.
    await service.upsert({ alias: 'vps', politica: 'livre' });
    await expect(
      service.forwardOpen({ host: 'vps', portaLocal: 8080, portaDestino: 80 }, context('sessao-1')),
    ).rejects.toThrow('só a IDE');
    const entries = await auditEntries();
    expect(entries.filter((e) => e.resultado === 'recusado')).toHaveLength(7);
    expect(entries.every((e) => e.ator !== 'ide')).toBe(true);
  });
});

/** Um "ssh" de verdade (outro processo) que escuta na porta do -L, para ver o processo morrer. */
describe('com um processo ssh real', () => {
  let dir: string;
  let script: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-fwdreal-'));
    script = join(dir, 'ssh-falso.mjs');
    await writeFile(
      script,
      [
        "import { createServer } from 'node:net';",
        'const args = process.argv.slice(2);',
        "const spec = args[args.indexOf('-L') + 1].split(':');",
        'createServer((socket) => socket.end()).listen(Number(spec[1]), spec[0]);',
        'setInterval(() => undefined, 1000);',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => {
          resolve(port);
        });
      });
    });
  }

  function listening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        resolve(false);
      });
    });
  }

  it('abre a porta local, e fechar e dispose matam o processo', async () => {
    const port = await freePort();
    const other = await freePort();
    const pids: number[] = [];
    const forwards = new ForwardManager({
      resolve: (s) => Promise.resolve({ command: 'node', args: buildForwardArgs(configHost, s) }),
      spawn: (_command, args) => {
        const child = spawn(process.execPath, [script, ...args], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        if (child.pid) pids.push(child.pid);
        return child;
      },
    });
    await forwards.open({ ...spec, portaLocal: port }, false);
    await forwards.open({ ...spec, portaLocal: other }, false);
    expect(await listening(port)).toBe(true);
    expect(await listening(other)).toBe(true);

    await forwards.close(`vps:${String(port)}`, false);
    await eventually(async () => !(await listening(port)));
    await forwards.dispose();
    await eventually(async () => !(await listening(other)));
    expect(pids).toHaveLength(2);
  });
});

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('a condição não ocorreu a tempo');
}
