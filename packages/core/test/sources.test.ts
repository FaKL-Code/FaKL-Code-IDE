import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countSource,
  isGitUrl,
  McpLibrary,
  ResourceLibrary,
  ResourceSources,
  Router,
} from '../src/index.js';
import { SecretVault } from '../src/secrets.js';

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Uma fonte com um agente, uma skill e um modelo de MCP. */
async function writeSource(dir: string, agent = 'revisor', description = 'Revisa diffs.') {
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(
    join(dir, 'agents', `${agent}.md`),
    `---\nname: ${agent}\ndescription: ${description}\nfakl:\n  nivel: padrao\n---\n\nCorpo.\n`,
  );
  await mkdir(join(dir, 'skills', 'pdf'), { recursive: true });
  await writeFile(
    join(dir, 'skills', 'pdf', 'SKILL.md'),
    '---\nname: pdf\n---\n\nUse pdftotext.\n',
  );
  await writeFile(
    join(dir, 'mcps.json'),
    JSON.stringify({ servers: { time: { command: 'uvx', args: ['mcp-server-time'] } } }),
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Teste', '-c', 'user.email=teste@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

/** Repositório git local com a fonte, para clonar por `file://`. */
async function gitSource(dir: string): Promise<string> {
  await writeSource(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'recursos');
  return pathToFileURL(dir).href;
}

describe('fontes de recursos', () => {
  let root: string;
  let fakl: string;
  let changes: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-sources-'));
    fakl = join(root, 'home', '.fakl');
    changes = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const open = async (): Promise<ResourceSources> => {
    const sources = new ResourceSources({ dir: fakl, onChange: () => changes++ });
    await sources.load();
    return sources;
  };

  it('começa sem nenhuma fonte', async () => {
    const sources = await open();
    expect(await sources.list()).toEqual([]);
    expect(sources.roots()).toEqual([]);
    expect(sources.size).toBe(0);
    expect(await sources.update()).toEqual([]);
    expect(await exists(join(fakl, 'sources.json'))).toBe(false);
  });

  it('cadastra uma pasta local, conta o que ela oferece e lê no lugar', async () => {
    const folder = join(root, 'Meus Recursos');
    await writeSource(folder);
    const sources = await open();

    const added = await sources.add({ caminho: folder });
    expect(added).toMatchObject({
      id: 'meus-recursos',
      nome: 'Meus Recursos',
      tipo: 'pasta',
      caminho: folder,
      agents: 1,
      skills: 1,
      mcps: 1,
    });
    expect(added).not.toHaveProperty('erro');
    expect(sources.roots()).toEqual([{ id: 'meus-recursos', nome: 'Meus Recursos', dir: folder }]);
    expect(changes).toBe(1);

    // O que muda na pasta aparece sem atualizar.
    await writeSource(folder, 'outro');
    expect((await sources.list())[0]).toMatchObject({ agents: 2 });
    await expect(sources.add({ caminho: folder })).rejects.toThrow(/já é uma fonte/);
    await expect(sources.add({ caminho: join(root, 'nao-existe') })).rejects.toThrow(
      /não é uma pasta/,
    );
    await expect(sources.add({ caminho: 'relativo' })).rejects.toThrow(/absoluto/);
    await expect(sources.add({})).rejects.toThrow(/url .* ou caminho/);

    // Persistido para a próxima abertura.
    const reopened = await open();
    expect(reopened.roots().map((r) => r.id)).toEqual(['meus-recursos']);

    await rm(folder, { recursive: true });
    expect((await reopened.list())[0]).toMatchObject({ erro: 'a pasta não existe mais' });
    const [updated] = await reopened.update('meus-recursos');
    expect(updated?.erro).toBe('a pasta não existe mais');
  });

  it('clona um repositório git, atualiza e apaga o clone ao remover', async () => {
    const repo = join(root, 'repo');
    const url = await gitSource(repo);
    const sources = await open();

    const added = await sources.add({ url, nome: 'Recursos do time' });
    const clone = join(fakl, 'sources', 'recursos-do-time');
    expect(added).toMatchObject({
      id: 'recursos-do-time',
      nome: 'Recursos do time',
      tipo: 'git',
      url,
      branch: 'main',
      caminho: clone,
      agents: 1,
      skills: 1,
      mcps: 1,
    });
    expect(added.commit).toBe(git(repo, 'rev-parse', '--short', 'HEAD'));
    expect(await readFile(join(clone, 'skills', 'pdf', 'SKILL.md'), 'utf8')).toContain('pdftotext');
    await expect(sources.add({ url })).rejects.toThrow(/já está cadastrada/);

    // Commit novo no remoto: só chega depois de atualizar.
    await writeSource(repo, 'novo');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'novo agente');
    expect((await sources.list())[0]).toMatchObject({ agents: 1 });
    // Uma alteração local no clone (só leitura) é descartada na atualização.
    await writeFile(join(clone, 'agents', 'lixo.md'), '---\nname: lixo\n---\n');
    const [updated] = await sources.update('recursos-do-time');
    expect(updated).toMatchObject({ agents: 2, commit: git(repo, 'rev-parse', '--short', 'HEAD') });
    expect(updated).not.toHaveProperty('erro');
    expect(await exists(join(clone, 'agents', 'lixo.md'))).toBe(false);

    // Remoto fora do ar: o erro fica na fonte e o clone anterior continua.
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    const [failed] = await sources.update();
    expect(failed?.erro).toMatch(/git fetch falhou/);
    expect(failed).toMatchObject({ agents: 2 });

    expect(await sources.remove('recursos-do-time')).toBe(true);
    expect(await sources.remove('recursos-do-time')).toBe(false);
    expect(await exists(clone)).toBe(false);
    expect(JSON.parse(await readFile(join(fakl, 'sources.json'), 'utf8'))).toEqual({
      fontes: [],
    });
  });

  it('respeita o branch pedido e recusa clone que falha sem cadastrar nada', async () => {
    const repo = join(root, 'repo');
    const url = await gitSource(repo);
    git(repo, 'checkout', '-q', '-b', 'extra');
    await writeSource(repo, 'so-no-extra');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'extra');
    git(repo, 'checkout', '-q', 'main');
    const sources = await open();

    const added = await sources.add({ url, branch: 'extra' });
    expect(added).toMatchObject({ id: 'repo', branch: 'extra', agents: 2 });

    await expect(sources.add({ url, branch: 'nao-existe' })).rejects.toThrow(/git clone falhou/);
    await expect(sources.add({ url, branch: '../x' })).rejects.toThrow(/branch inválido/);
    expect(sources.roots().map((r) => r.id)).toEqual(['repo']);
  });

  it('baixa o repositório cadastrado em outra máquina (sources.json sem clone)', async () => {
    const url = await gitSource(join(root, 'repo'));
    await mkdir(fakl, { recursive: true });
    await writeFile(
      join(fakl, 'sources.json'),
      JSON.stringify({
        fontes: [
          { id: 'time', nome: 'Time', tipo: 'git', url, branch: 'main' },
          { id: '../fora', nome: 'x', tipo: 'pasta', caminho: root },
          { id: 'perigoso', nome: 'x', tipo: 'git', url: 'ext::sh -c touch% /tmp/x' },
        ],
      }),
    );
    const logs: string[] = [];
    const sources = new ResourceSources({ dir: fakl, log: (m) => logs.push(m) });
    await sources.load();
    expect(sources.roots().map((r) => r.id)).toEqual(['time']);
    expect(logs.filter((m) => m.includes('fonte ignorada'))).toHaveLength(2);
    expect((await sources.list())[0]?.erro).toMatch(/ainda não foi baixado/);

    await sources.ensureClones();
    expect((await sources.list())[0]).toMatchObject({ agents: 1, skills: 1, mcps: 1 });
    expect((await sources.list())[0]).not.toHaveProperty('erro');
  });

  it('só aceita URLs de transportes que não rodam comandos', () => {
    for (const url of [
      'https://github.com/org/repo.git',
      'ssh://git@github.com/org/repo.git',
      'git@github.com:org/repo.git',
      'file:///tmp/repo',
    ]) {
      expect(isGitUrl(url), url).toBe(true);
    }
    for (const url of [
      'ext::sh -c touch% /tmp/pwned',
      '--upload-pack=touch /tmp/x',
      '-u',
      '/caminho/local',
      'C:\\repo',
      'fd::17',
      '',
    ]) {
      expect(isGitUrl(url), url).toBe(false);
    }
  });

  it('conta agents/, skills/ e mcps.json, todos opcionais', async () => {
    expect(await countSource(join(root, 'nada'))).toEqual({ agents: 0, skills: 0, mcps: 0 });
    const dir = join(root, 'fonte');
    await mkdir(join(dir, 'skills', 'sem-skill-md'), { recursive: true });
    await writeFile(join(dir, 'mcps.json'), '{ quebrado');
    expect(await countSource(dir)).toEqual({ agents: 0, skills: 0, mcps: 0 });
  });

  it('responde pelo RPC sources.*', async () => {
    const folder = join(root, 'pasta');
    await writeSource(folder);
    const sources = await open();
    const router = new Router();
    sources.register(router);
    const call = (method: string, params?: unknown): Promise<unknown> =>
      router.dispatch(method, params, {} as never);

    expect(await call('sources.list')).toEqual([]);
    expect(await call('sources.add', { caminho: folder, nome: 'Pasta' })).toMatchObject({
      id: 'pasta',
      agents: 1,
    });
    expect(await call('sources.update')).toMatchObject([{ id: 'pasta' }]);
    expect(await call('sources.update', { id: 'pasta' })).toMatchObject([{ id: 'pasta' }]);
    await expect(call('sources.update', { id: 'outra' })).rejects.toThrow(/não existe/);
    await expect(call('sources.add', { caminho: 3 })).rejects.toThrow(/caminho deve ser texto/);
    await expect(call('sources.add', { url: 'ext::x' })).rejects.toThrow(/URL de repositório/);
    expect(await call('sources.remove', { id: 'pasta' })).toBe(true);
    // A pasta local nunca é apagada ao remover a fonte.
    expect(await exists(join(folder, 'agents', 'revisor.md'))).toBe(true);
  });

  it('instala de uma fonte git e o item fica depois de remover a fonte', async () => {
    const url = await gitSource(join(root, 'repo'));
    const sources = await open();
    await sources.add({ url });
    const library = new ResourceLibrary({
      dir: join(fakl, 'resources'),
      sources: () => sources.roots(),
    });
    await library.init();
    const mcps = new McpLibrary({
      file: join(fakl, 'mcp.json'),
      sources: () => sources.roots(),
      vault: new SecretVault(),
    });

    expect((await library.catalog()).agents).toMatchObject([{ name: 'revisor', fonte: 'repo' }]);
    await library.install('agent', ['revisor'], 'repo');
    await mcps.install(['time'], 'repo');
    await sources.remove('repo');

    expect(await library.catalog()).toEqual({ agents: [], skills: [] });
    expect((await library.list()).agents).toMatchObject([
      { name: 'revisor', origem: 'fonte', fonte: 'repo' },
    ]);
    expect((await mcps.list()).servers.map((s) => s.name)).toEqual(['time']);
    expect(await mcps.catalog()).toEqual({ servers: [] });
  });
});
