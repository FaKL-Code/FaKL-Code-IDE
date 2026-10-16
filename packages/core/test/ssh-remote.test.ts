import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { policyVerdict } from '@fakl/integrations';
import type { AgentPermissionEventData, FaklEvent } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseRemoteRoots, remoteContext } from '../src/agents.js';
import { EventBus } from '../src/events/bus.js';
import { run } from '../src/exec.js';
import { SshService } from '../src/integrations/ssh.js';
import {
  checkPath,
  classifyOperation,
  decodeContent,
  encodeContent,
  fromBase64,
  isSensitivePath,
  listScript,
  multiplexArgs,
  parseList,
  parseStat,
  quote,
  readScript,
  remotePath,
  statScript,
  toBase64Lines,
  withCwd,
  writeScript,
} from '../src/integrations/ssh-remote.js';
import type { CallContext } from '../src/rpc/router.js';
import { Approvals } from '../src/security/approvals.js';
import { AuditLog } from '../src/security/audit.js';

const hasSh = spawnSync('sh', ['-c', 'true']).status === 0;

function context(principal?: string): CallContext {
  return { connectionId: 'c', principal, notify: () => undefined, onClose: () => undefined };
}

describe('classificação das operações de arquivo', () => {
  it('ler, listar e consultar são leitura; gravar é escrita', () => {
    expect(classifyOperation('read')).toBe('leitura');
    expect(classifyOperation('list')).toBe('leitura');
    expect(classifyOperation('stat')).toBe('leitura');
    expect(classifyOperation('write')).toBe('escrita');
  });

  it('a política do host decide: leitura roda direto, escrita pede aprovação', () => {
    const read = classifyOperation('read');
    const write = classifyOperation('write');
    expect(policyVerdict('livre', read)).toBe('executar');
    expect(policyVerdict('livre', write)).toBe('executar');
    expect(policyVerdict('leitura', read)).toBe('executar');
    expect(policyVerdict('leitura', write)).toBe('confirmar');
    expect(policyVerdict('confirmar', read)).toBe('confirmar');
    expect(policyVerdict('confirmar', write)).toBe('confirmar');
    expect(policyVerdict('bloqueado', read)).toBe('recusar');
    expect(policyVerdict('bloqueado', write)).toBe('recusar');
  });

  it('agentes não acessam ~/.ssh nem /etc/shadow', () => {
    expect(isSensitivePath('/home/x/.ssh/id_ed25519')).toBe(true);
    expect(isSensitivePath('~/.ssh')).toBe(true);
    expect(isSensitivePath('/home/x/../x/.ssh/authorized_keys')).toBe(true);
    expect(isSensitivePath('/etc/shadow')).toBe(true);
    expect(isSensitivePath('/srv/app/.sshfoo/a')).toBe(false);
    expect(isSensitivePath('/srv/app/index.php')).toBe(false);
  });
});

describe('escape de caminhos e comandos', () => {
  const hostile = [
    "it's",
    '$(touch /tmp/pwn)',
    '`id`',
    '"; rm -rf / #',
    "'; rm -rf / #",
    'a\nb',
    '-rf',
    'espaço e $HOME',
    '~',
    '~/x y',
  ];

  it('quote fecha o valor entre aspas simples', () => {
    expect(quote('abc')).toBe("'abc'");
    expect(quote("it's")).toBe(`'it'\\''s'`);
  });

  it('remotePath expande só o ~ inicial, e o resto sempre entre aspas', () => {
    expect(remotePath('~')).toBe('"$HOME"');
    expect(remotePath('~/a b')).toBe(`"$HOME"/'a b'`);
    expect(remotePath('/srv/$HOME')).toBe("'/srv/$HOME'");
    expect(remotePath('~outro')).toBe("'~outro'");
  });

  it('os scripts nunca deixam o valor solto (sem injeção)', () => {
    for (const value of hostile) {
      for (const script of [
        readScript(value, 10),
        writeScript(value, true),
        writeScript(value, false),
        statScript(value),
        listScript(value),
        withCwd('ls', value),
      ]) {
        // Tirando os trechos entre aspas simples, nada do valor hostil pode sobrar no sh.
        const stripped = script.replace(/'(?:[^']|'\\'')*'/g, "''");
        expect(stripped).not.toContain('touch');
        expect(stripped).not.toContain('rm -rf');
        expect(stripped).not.toContain('`id`');
      }
    }
  });

  it('rejeita caminho vazio ou com NUL', () => {
    expect(() => checkPath('', 'caminho')).toThrow('vazio');
    expect(() => checkPath('  ', 'caminho')).toThrow('vazio');
    expect(() => checkPath('a\0b', 'caminho')).toThrow('inválido');
    expect(checkPath('/ok', 'caminho')).toBe('/ok');
  });

  it('cwd vazio não muda o comando; com cwd, o comando só roda se o cd der certo', () => {
    expect(withCwd('ls', undefined)).toBe('ls');
    expect(withCwd('ls', '')).toBe('ls');
    expect(withCwd('ls; pwd', '/srv/app')).toBe("cd -- '/srv/app' && {\nls; pwd\n}");
  });

  it.runIf(hasSh)('executados de verdade, valores hostis ficam como texto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fakl-esc-'));
    try {
      // Relativo ao cwd do teste; sem `/` nem `:` para valer também no Windows.
      const marker = join(dir, 'pwn');
      const name = "$(touch pwn) it's `touch pwn`; touch pwn";
      const file = name;
      const payload = new Uint8Array([0, 1, 2, 255, 10, 13, 36, 39, 96]);
      const write = await run('sh', ['-c', writeScript(file, false)], {
        cwd: dir,
        input: toBase64Lines(payload),
      });
      expect(write.code).toBe(0);
      expect(new Uint8Array(await readFile(join(dir, file)))).toEqual(payload);
      const read = await run('sh', ['-c', readScript(file, 1000)], { cwd: dir });
      expect(new Uint8Array(fromBase64(read.stdout))).toEqual(payload);
      const list = await run('sh', ['-c', listScript('.')], { cwd: dir });
      expect(parseList(list.stdout)).toEqual([{ nome: name, tipo: 'file' }]);
      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('base64 de ida e volta', () => {
  it('binário arbitrário volta igual', () => {
    const data = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
    const lines = toBase64Lines(data);
    expect(lines.split('\n').every((line) => line.length <= 76)).toBe(true);
    expect(new Uint8Array(fromBase64(lines))).toEqual(data);
  });

  it('texto UTF-8 com acentos e emoji', () => {
    const text = 'olá, mundo! ção 🚀\nlinha 2\r\n';
    const decoded = decodeContent(fromBase64(toBase64Lines(encodeContent(text, 'utf8'))), 1000);
    expect(decoded).toEqual({
      conteudo: text,
      codificacao: 'utf8',
      bytes: Buffer.byteLength(text),
      truncado: false,
    });
  });

  it('conteudo em base64 é decodificado, e inválido é recusado', () => {
    const buf = encodeContent(Buffer.from([0, 255, 128]).toString('base64'), 'base64');
    expect([...buf]).toEqual([0, 255, 128]);
    expect(() => encodeContent('não é base64!', 'base64')).toThrow('base64');
  });

  it('binário sai em base64; corte no meio de um caractere não quebra o texto', () => {
    const binary = decodeContent(Buffer.from([0xff, 0xfe, 0x00]), 10);
    expect(binary.codificacao).toBe('base64');
    expect(Buffer.from(binary.conteudo, 'base64')).toEqual(Buffer.from([0xff, 0xfe, 0x00]));
    const cut = decodeContent(Buffer.from('aé🚀'), 4);
    expect(cut).toMatchObject({ conteudo: 'aé', codificacao: 'utf8', truncado: true });
  });
});

describe('saída dos comandos', () => {
  it('parseStat lê tipo, tamanho e data', () => {
    expect(parseStat('81a4 120 1700000000\n')).toEqual({
      tipo: 'file',
      tamanho: 120,
      modificadoEm: 1700000000,
    });
    expect(parseStat('41ed 4096 5')?.tipo).toBe('dir');
    expect(parseStat('')).toBeUndefined();
  });

  it('parseList separa tipo e nome, mesmo com espaços', () => {
    expect(parseList('d src\nf a b.txt\no sock\n')).toEqual([
      { nome: 'src', tipo: 'dir' },
      { nome: 'a b.txt', tipo: 'file' },
      { nome: 'sock', tipo: 'other' },
    ]);
  });

  it('multiplexação fica desligada no Windows', () => {
    expect(multiplexArgs('win32')).toEqual([]);
    expect(multiplexArgs('linux')).toContain('ControlMaster=auto');
    expect(multiplexArgs('darwin').join(' ')).toContain('ControlPersist=60');
  });
});

describe('contexto remoto do agente', () => {
  it('valida as raízes e monta o texto do prompt', () => {
    expect(parseRemoteRoots(undefined)).toEqual([]);
    const roots = parseRemoteRoots([{ host: 'site-prod', caminho: '/var/www' }]);
    expect(remoteContext(roots)).toContain('- host site-prod: /var/www');
    expect(remoteContext(roots)).toContain('ssh_read');
    expect(remoteContext([])).toBe('');
    expect(() => parseRemoteRoots([{ host: 'a b', caminho: '/x' }])).toThrow('remotas');
    expect(() => parseRemoteRoots([{ host: 'ok', caminho: 'relativo' }])).toThrow('remotas');
    expect(() => parseRemoteRoots([{ host: 'ok', caminho: '/x\ny' }])).toThrow('remotas');
    expect(() => parseRemoteRoots('x')).toThrow('lista');
  });
});

describe.runIf(hasSh)('ssh.read/write/list/stat no SshService', () => {
  let dir: string;
  let remote: string;
  let service: SshService;
  let audit: AuditLog;
  let answers: boolean[];
  let asked: string[];
  let snapshots: string[];
  let calls: string[][];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-sshops-'));
    remote = join(dir, 'servidor');
    await mkdir(remote);
    await mkdir(join(dir, 'home', '.ssh'), { recursive: true });
    await writeFile(
      join(dir, 'home', '.ssh', 'config'),
      'Host vps\n  HostName 203.0.113.10\nHost hs\n  HostName 198.51.100.7\n',
    );
    const bus = new EventBus();
    const approvals = new Approvals(bus);
    audit = new AuditLog(join(dir, 'audit.jsonl'));
    answers = [];
    asked = [];
    snapshots = [];
    calls = [];
    bus.subscribe(['agent.permission'], (event: FaklEvent) => {
      const data = event.data as AgentPermissionEventData;
      asked.push(data.title);
      const answer = answers.shift() ?? false;
      setTimeout(() => approvals.respond(event.subject, data.id, answer), 0);
    });
    service = new SshService({
      approvals,
      audit,
      home: join(dir, 'home'),
      file: join(dir, 'hosts.json'),
      multiplex: false,
      beforeWrite: (host) => {
        snapshots.push(host.alias);
        return Promise.resolve({ ok: true, id: 'snap-9' });
      },
      // Servidor falso: o último argumento do ssh é o script, que roda num sh local.
      runner: (_command, args, options) => {
        calls.push([...args]);
        const script = args[args.length - 1] ?? '';
        return run('sh', ['-c', script], options);
      },
    });
    await service.load();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a IDE grava, lê, lista e consulta sem passar pela política', async () => {
    const file = join(remote, 'a b.txt');
    const written = await service.write(
      { host: 'vps', caminho: file, conteudo: 'olá ✓' },
      context(),
    );
    expect(written).toEqual({ bytes: Buffer.byteLength('olá ✓') });
    expect(await readFile(file, 'utf8')).toBe('olá ✓');
    const read = await service.read({ host: 'vps', caminho: file }, context());
    expect(read).toEqual({
      conteudo: 'olá ✓',
      codificacao: 'utf8',
      bytes: Buffer.byteLength('olá ✓'),
      truncado: false,
    });
    expect((await service.list({ host: 'vps', caminho: remote }, context())).entradas).toEqual([
      { nome: 'a b.txt', tipo: 'file' },
    ]);
    expect(await service.stat({ host: 'vps', caminho: file }, context())).toMatchObject({
      existe: true,
      tipo: 'file',
    });
    expect(await service.stat({ host: 'vps', caminho: join(remote, 'nada') }, context())).toEqual({
      existe: false,
    });
    expect(asked).toEqual([]);
  });

  it('base64 e pastas novas', async () => {
    const file = join(remote, 'novo', 'bin.dat');
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13]);
    await service.write(
      {
        host: 'vps',
        caminho: file,
        conteudo: bytes.toString('base64'),
        codificacao: 'base64',
        criarPastas: true,
      },
      context(),
    );
    expect(await readFile(file)).toEqual(bytes);
    const read = await service.read({ host: 'vps', caminho: file }, context());
    expect(read.codificacao).toBe('base64');
    expect(Buffer.from(read.conteudo, 'base64')).toEqual(bytes);
    // Sem criarPastas, uma pasta que falta é erro.
    await expect(
      service.write({ host: 'vps', caminho: join(remote, 'x', 'y'), conteudo: 'a' }, context()),
    ).rejects.toThrow();
  });

  it('agente: leitura em host "leitura" roda direto; escrita pede aprovação', async () => {
    await service.upsert({ alias: 'vps', politica: 'leitura' });
    const file = join(remote, 'f.txt');
    await writeFile(file, 'conteúdo');
    const read = await service.read({ host: 'vps', caminho: file }, context('s1'));
    expect(read.conteudo).toContain('conteúdo');
    expect(read.conteudo).toContain('conteudo-externo');
    expect(asked).toEqual([]);

    answers.push(false);
    await expect(
      service.write({ host: 'vps', caminho: file, conteudo: 'x' }, context('s1')),
    ).rejects.toThrow('negou');
    expect(asked[0]).toContain(file);
    expect(await readFile(file, 'utf8')).toBe('conteúdo');

    answers.push(true);
    await service.write({ host: 'vps', caminho: file, conteudo: 'novo' }, context('s1'));
    expect(await readFile(file, 'utf8')).toBe('novo');
  });

  it('agente: host bloqueado recusa tudo e a auditoria registra', async () => {
    await service.upsert({ alias: 'vps', politica: 'bloqueado' });
    await expect(
      service.read({ host: 'vps', caminho: join(remote, 'a') }, context('s1')),
    ).rejects.toThrow('bloqueado');
    await expect(service.list({ host: 'vps', caminho: remote }, context('s1'))).rejects.toThrow(
      'bloqueado',
    );
    const log = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(log).toContain('"acao":"ssh.read"');
    expect(log).toContain('"resultado":"recusado"');
    expect(calls).toEqual([]);
  });

  it('agente: ~/.ssh é recusado antes de qualquer conexão; o conteúdo gravado não vai para a auditoria', async () => {
    await service.upsert({ alias: 'vps', politica: 'livre' });
    await expect(
      service.read({ host: 'vps', caminho: '/home/x/.ssh/id_ed25519' }, context('s1')),
    ).rejects.toThrow('~/.ssh');
    expect(calls).toEqual([]);
    await service.write(
      { host: 'vps', caminho: join(remote, 's.txt'), conteudo: 'SEGREDO-NO-CONTEUDO' },
      context('s1'),
    );
    const log = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(log).toContain('"acao":"ssh.write"');
    expect(log).not.toContain('SEGREDO-NO-CONTEUDO');
  });

  it('escrita num VPS da Hostinger faz snapshot antes; leitura não', async () => {
    await service.syncHostinger([{ id: 7, hostname: 'srv7.hstgr.cloud', address: '198.51.100.9' }]);
    await service.upsert({ alias: 'hostinger-srv7', politica: 'livre' });
    const file = join(remote, 'h.txt');
    const written = await service.write(
      { host: 'hostinger-srv7', caminho: file, conteudo: 'a' },
      context('s1'),
    );
    expect(snapshots).toEqual(['hostinger-srv7']);
    expect(written.snapshot).toBe('snap-9');
    await service.read({ host: 'hostinger-srv7', caminho: file }, context('s1'));
    expect(snapshots).toHaveLength(1);
  });

  it('exec com cwd roda na pasta, e cwd inexistente não roda o comando', async () => {
    await writeFile(join(remote, 'marca.txt'), 'x');
    const ok = await service.exec({ host: 'vps', comando: 'ls', cwd: remote }, context());
    expect(ok.saida.trim()).toBe('marca.txt');
    const bad = await service.exec(
      { host: 'vps', comando: 'echo rodou', cwd: join(remote, 'nao-existe') },
      context(),
    );
    expect(bad.codigo).not.toBe(0);
    expect(bad.saida).not.toContain('rodou');
  });

  it('parâmetros inválidos viram erro de parâmetro', async () => {
    await expect(service.read({ host: 'vps', caminho: '' }, context())).rejects.toThrow();
    await expect(
      service.write(
        { host: 'vps', caminho: '/x', conteudo: '%%%', codificacao: 'base64' },
        context(),
      ),
    ).rejects.toThrow('base64');
  });
});
