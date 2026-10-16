import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpLibrary } from '../src/index.js';
import { SecretVault } from '../src/secrets.js';

const CATALOG = {
  inputs: [
    { id: 'gh', type: 'promptString', description: 'Token do GitHub', password: true },
    { id: 'outro', type: 'promptString', description: 'Não usado' },
  ],
  servers: {
    github: {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${input:gh}' },
      fakl: { descricao: 'GitHub', categoria: 'Código' },
    },
    git: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git', '--repository', '${workspaceFolder}'],
      fakl: { descricao: 'Git' },
    },
  },
};

describe('biblioteca de servidores MCP', () => {
  let root: string;
  let file: string;
  let vault: SecretVault;
  let library: McpLibrary;
  let logs: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-mcps-'));
    file = join(root, 'mcp.json');
    await mkdir(join(root, 'fonte'), { recursive: true });
    await writeFile(join(root, 'fonte', 'mcps.json'), JSON.stringify(CATALOG));
    vault = new SecretVault();
    logs = [];
    library = new McpLibrary({
      file,
      sources: () => [{ id: 'base', nome: 'Base', dir: join(root, 'fonte') }],
      vault,
      log: (m) => logs.push(m),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('instala de uma fonte levando só os segredos usados', async () => {
    expect((await library.catalog()).servers.map((s) => [s.name, s.fonte, s.instalado])).toEqual([
      ['github', 'base', false],
      ['git', 'base', false],
    ]);
    const info = await library.install(['github']);
    expect(info.servers).toMatchObject([
      { name: 'github', type: 'http', faltando: ['gh'], inputs: [{ id: 'gh', password: true }] },
    ]);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { inputs: { id: string }[] };
    expect(saved.inputs.map((i) => i.id)).toEqual(['gh']);
    expect((await library.catalog()).servers[0]?.instalado).toBe(true);
    await expect(library.install(['nao-existe'])).rejects.toThrow(/não está em nenhuma fonte/);
  });

  it('só entrega o servidor às sessões depois que o segredo chega ao cofre', async () => {
    await library.install(['github', 'git']);
    await library.refresh();
    expect(library.current().map((s) => s.nome)).toEqual(['git']);
    expect(logs.some((m) => m.includes('github') && m.includes('gh'))).toBe(true);

    vault.set('mcp.gh', 'segredo-123');
    await library.refresh();
    expect(library.current()).toEqual([
      {
        nome: 'github',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer segredo-123' },
      },
      {
        nome: 'git',
        comando: 'uvx',
        args: ['mcp-server-git', '--repository', '${workspaceFolder}'],
        env: {},
      },
    ]);
    // O segredo nunca vai para o arquivo.
    expect(await readFile(file, 'utf8')).not.toContain('segredo-123');
  });

  it('não sobrescreve um servidor que o usuário editou', async () => {
    await library.install(['git']);
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      servers: Record<string, { args: string[] }>;
    };
    saved.servers.git = { ...saved.servers.git, args: ['meu-arg'] };
    await writeFile(file, JSON.stringify(saved));
    await library.install(['git']);
    expect((await library.list()).servers[0]).toMatchObject({ name: 'git', args: ['meu-arg'] });
  });

  it('remove o servidor e os segredos que ninguém mais usa', async () => {
    await library.install(['github', 'git']);
    expect(await library.remove('github')).toBe(true);
    expect(await library.remove('github')).toBe(false);
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      inputs: unknown[];
      servers: Record<string, unknown>;
    };
    expect(Object.keys(saved.servers)).toEqual(['git']);
    expect(saved.inputs).toEqual([]);
  });

  it('ignora servidor malformado e não apaga um arquivo ilegível', async () => {
    await writeFile(
      file,
      JSON.stringify({
        servers: { ruim: { type: 'stdio' }, bom: { command: 'node', args: ['x'] } },
      }),
    );
    expect((await library.list()).servers.map((s) => s.name)).toEqual(['bom']);
    expect(logs.some((m) => m.includes('ruim'))).toBe(true);

    await writeFile(file, '{ quebrado');
    await expect(library.install(['git'])).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{ quebrado');
  });

  it('aceita segredos mcp.<id> no cofre e recusa nomes inventados', () => {
    const calls = new Map<string, (params: unknown, context: unknown) => unknown>();
    vault.register({
      register: (name: string, fn: (params: unknown, context: unknown) => unknown) =>
        calls.set(name, fn),
    } as never);
    const set = calls.get('secrets.set');
    set?.({ nome: 'mcp.gh', valor: 'x' }, {});
    expect(vault.has('mcp.gh')).toBe(true);
    expect(() => set?.({ nome: 'mcp.../x', valor: 'x' }, {})).toThrow(/segredo desconhecido/);
    expect(() => set?.({ nome: 'qualquer', valor: 'x' }, {})).toThrow(/segredo desconhecido/);
    expect(calls.get('secrets.status')?.(undefined, {})).toMatchObject({ 'mcp.gh': true });
  });
});

describe('modelos de MCP de várias fontes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-mcps-fontes-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('junta as fontes, instala da pedida e ignora mcps.json ausente ou ilegível', async () => {
    const write = async (name: string, content: string | undefined): Promise<string> => {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      if (content !== undefined) await writeFile(join(dir, 'mcps.json'), content);
      return dir;
    };
    const a = await write('a', JSON.stringify(CATALOG));
    const b = await write(
      'b',
      JSON.stringify({ servers: { git: { command: 'git-mcp', args: ['--b'] } } }),
    );
    const vazia = await write('vazia', undefined);
    const quebrada = await write('quebrada', '{ nada');
    const logs: string[] = [];
    const file = join(root, 'mcp.json');
    const library = new McpLibrary({
      file,
      sources: () => [
        { id: 'a', nome: 'A', dir: a },
        { id: 'vazia', nome: 'Vazia', dir: vazia },
        { id: 'quebrada', nome: 'Quebrada', dir: quebrada },
        { id: 'b', nome: 'B', dir: b },
      ],
      vault: new SecretVault(),
      log: (m) => logs.push(m),
    });

    expect((await library.catalog()).servers.map((s) => `${s.fonte}:${s.name}`)).toEqual([
      'a:github',
      'a:git',
      'b:git',
    ]);
    expect(logs.some((m) => m.includes('quebrada'))).toBe(true);

    await library.install(['git'], 'b');
    expect((await library.list()).servers).toMatchObject([
      { name: 'git', command: 'git-mcp', args: ['--b'] },
    ]);
    await expect(library.install(['github'], 'b')).rejects.toThrow(/não está na fonte b/);
    await expect(library.install(['git'], 'nenhuma')).rejects.toThrow(/não existe/);
  });

  it('sem fontes, o catálogo é vazio e nada se instala', async () => {
    const library = new McpLibrary({ file: join(root, 'mcp.json'), vault: new SecretVault() });
    expect(await library.catalog()).toEqual({ servers: [] });
    await expect(library.install(['github'])).rejects.toThrow(/nenhuma fonte/);
    expect(await library.list()).toMatchObject({ servers: [] });
  });
});
