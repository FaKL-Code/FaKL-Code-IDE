import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  chatMaestroPrompt,
  claudeModelAlias,
  geminiSubagent,
  isResourceName,
  MAESTRO_TOOLS,
  maestroPrompt,
  providerSyncTarget,
  RESOURCE_MANIFEST,
  ResourceLibrary,
  ResourceSync,
  resourceSlug,
  Router,
  RpcError,
  resourcesBriefing,
  syncResources,
  workerPrompt,
  type ResourceSummary,
  type SourceRoot,
} from '../src/index.js';

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

function agentFile(name: string, description: string, fakl: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nfakl:\n${fakl}\n---\n\nVocê é o agente ${name}.\n`;
}

async function writeCatalog(root: string): Promise<void> {
  await mkdir(join(root, 'agents'), { recursive: true });
  await writeFile(
    join(root, 'agents', 'revisor.md'),
    agentFile(
      'revisor',
      'Revisa diffs com foco em bugs.',
      '  nivel: padrao\n  perfil: claude-sonnet\n  modelo: claude-sonnet-5-5\n  alternativa: codex\n  fontes:\n    - https://example.com/revisor\n  licenca: MIT',
    ),
  );
  await mkdir(join(root, 'skills', 'pdf'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'pdf', 'SKILL.md'),
    '---\nname: pdf\ndescription: Lê e gera PDFs.\nfakl:\n  nivel: leve\n  perfil: claude-haiku\n---\n\nUse pdftotext.\n',
  );
  await writeFile(join(root, 'skills', 'pdf', 'LICENSE.txt'), 'licença');
}

describe('biblioteca de recursos', () => {
  let root: string;
  let catalog: string;
  let dir: string;
  let roots: SourceRoot[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-resources-'));
    catalog = join(root, 'fonte-base');
    dir = join(root, 'home', '.fakl', 'resources');
    await writeCatalog(catalog);
    roots = [{ id: 'base', nome: 'Base', dir: catalog }];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const open = async (): Promise<ResourceLibrary> => {
    const library = new ResourceLibrary({ dir, sources: () => roots });
    await library.init();
    return library;
  };

  it('começa vazia, mesmo com fontes, e não instala nada sozinha', async () => {
    const library = await open();
    expect(await library.list()).toEqual({ agents: [], skills: [], dir });
    const listed = await library.catalog();
    expect(listed.agents).toMatchObject([
      { name: 'revisor', fonte: 'base', origem: 'fonte', instalado: false },
    ]);
    expect(listed.skills).toMatchObject([{ name: 'pdf', fonte: 'base', instalado: false }]);
    expect(await exists(join(dir, 'state.json'))).toBe(false);
  });

  it('instala de uma fonte, lê o bloco fakl e guarda a origem', async () => {
    const library = await open();
    const [agent] = await library.install('agent', ['revisor']);
    await library.install('skill', ['pdf'], 'base');
    expect(agent).toMatchObject({
      kind: 'agent',
      description: 'Revisa diffs com foco em bugs.',
      nivel: 'padrao',
      perfil: 'claude-sonnet',
      modelo: 'claude-sonnet-5-5',
      alternativa: 'codex',
      fontes: ['https://example.com/revisor'],
      licenca: 'MIT',
      origem: 'fonte',
      fonte: 'base',
      path: join(dir, 'agents', 'revisor.md'),
    });
    expect(await readFile(join(dir, 'skills', 'pdf', 'LICENSE.txt'), 'utf8')).toBe('licença');
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual({
      origens: { 'agent:revisor': 'base', 'skill:pdf': 'base' },
    });
    const reopened = await open();
    expect((await reopened.list()).skills).toMatchObject([{ name: 'pdf', fonte: 'base' }]);
    expect((await reopened.catalog()).agents).toMatchObject([{ name: 'revisor', instalado: true }]);
  });

  it('escolhe a fonte pedida ou a primeira que tiver o item', async () => {
    const outra = join(root, 'outra');
    await mkdir(join(outra, 'agents'), { recursive: true });
    await writeFile(
      join(outra, 'agents', 'revisor.md'),
      agentFile('revisor', 'Revisor da outra fonte.', '  nivel: leve'),
    );
    roots = [...roots, { id: 'outra', nome: 'Outra', dir: outra }];
    const library = await open();
    expect((await library.catalog()).agents.map((a) => a.fonte)).toEqual(['base', 'outra']);

    const [picked] = await library.install('agent', ['revisor'], 'outra');
    expect(picked).toMatchObject({ description: 'Revisor da outra fonte.', fonte: 'outra' });
    await library.remove('agent', 'revisor');
    const [first] = await library.install('agent', ['revisor']);
    expect(first).toMatchObject({ description: 'Revisa diffs com foco em bugs.', fonte: 'base' });

    await expect(library.install('agent', ['revisor'], 'nenhuma')).rejects.toThrow(/não existe/);
    await expect(library.install('skill', ['pdf'], 'outra')).rejects.toThrow(/não está na fonte/);
    await expect(library.install('agent', ['sumiu'])).rejects.toThrow(/nenhuma fonte/);
  });

  it('o item removido volta a ficar disponível na fonte', async () => {
    const library = await open();
    await library.install('agent', ['revisor']);
    expect(await library.remove('agent', 'revisor')).toBe(true);
    expect(await library.remove('agent', 'revisor')).toBe(false);
    expect((await library.list()).agents).toEqual([]);
    expect((await library.catalog()).agents).toMatchObject([{ name: 'revisor', instalado: false }]);
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual({ origens: {} });
  });

  it('marca itens opcionais, mas não instala nem os recomendados', async () => {
    await mkdir(join(catalog, 'skills', 'opcional'), { recursive: true });
    await writeFile(
      join(catalog, 'skills', 'opcional', 'SKILL.md'),
      '---\nname: opcional\ndescription: Só quando pedirem.\nfakl:\n  nivel: leve\n  padrao: false\n---\n',
    );
    const library = await open();
    expect((await library.list()).skills).toEqual([]);
    const listed = await library.catalog();
    expect(listed.skills).toMatchObject([
      { name: 'opcional', instalado: false, padrao: false },
      { name: 'pdf', instalado: false },
    ]);
    expect(listed.skills[1]).not.toHaveProperty('padrao');
  });

  it('lê o state.json antigo (catálogo embutido) e sobrevive a um corrompido', async () => {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'agents', 'revisor.md'), agentFile('revisor', 'semeado', ''));
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ conhecidos: ['agent:revisor', 'skill:pdf'] }),
    );
    const library = await open();
    expect((await library.list()).agents).toMatchObject([{ name: 'revisor', origem: 'fonte' }]);
    expect((await library.list()).agents[0]).not.toHaveProperty('fonte');
    expect((await library.list()).skills).toEqual([]);

    await writeFile(join(dir, 'state.json'), '{"origens":');
    const logs: string[] = [];
    const reopened = new ResourceLibrary({ dir, sources: () => roots, log: (m) => logs.push(m) });
    await reopened.init();
    expect((await reopened.list()).agents).toMatchObject([{ name: 'revisor', origem: 'usuario' }]);
    expect(logs).toContain(
      'state.json dos recursos está corrompido; origens dos itens descartadas',
    );
  });

  it('não sobrescreve um item instalado que o usuário editou', async () => {
    const library = await open();
    await library.install('agent', ['revisor']);
    const file = join(dir, 'agents', 'revisor.md');
    await writeFile(file, '---\nname: revisor\ndescription: editado\n---\n');
    await writeFile(
      join(catalog, 'agents', 'revisor.md'),
      agentFile('revisor', 'versão nova', '  nivel: leve'),
    );
    await library.install('agent', ['revisor']);
    expect(await readFile(file, 'utf8')).toContain('editado');
  });

  it('cria um modelo em branco e lê o conteúdo', async () => {
    const library = await open();
    const created = await library.create('agent', 'Revisor de Segurança', 'Caça falhas.');
    expect(created).toMatchObject({
      name: 'revisor-de-seguranca',
      description: 'Caça falhas.',
      origem: 'usuario',
    });
    await expect(library.create('agent', 'revisor de segurança')).rejects.toThrow(/já existe/);
    const skill = await library.create('skill', 'Minha Skill');
    expect(skill.path).toBe(join(dir, 'skills', 'minha-skill', 'SKILL.md'));

    const got = await library.get('agent', 'revisor-de-seguranca');
    expect(got.content).toContain('# Revisor de Segurança');
    expect(got.info.nivel).toBe('padrao');
    await expect(library.get('skill', 'nao-existe')).rejects.toBeInstanceOf(RpcError);
  });

  it('lista os demais recursos mesmo com frontmatter malformado', async () => {
    const library = await open();
    await library.install('agent', ['revisor']);
    await writeFile(
      join(dir, 'agents', 'quebrado.md'),
      '---\ndescription: [yaml inválido\n---\n\nAinda é um agente.\n',
    );

    await expect(library.list()).resolves.toMatchObject({
      agents: [{ name: 'quebrado', description: '' }, { name: 'revisor' }],
    });
  });

  it('recusa nomes com caminho', async () => {
    const library = await open();
    for (const name of [
      '../x',
      '..',
      'a/b',
      'a\\b',
      '/etc/passwd',
      '',
      'A..b',
      '.oculto',
      'a.',
      'con',
      'nul.txt',
      'com1',
    ]) {
      expect(isResourceName(name)).toBe(false);
    }
    expect(resourceSlug('../../etc')).toBe('etc');
    await expect(library.get('agent', '../state')).rejects.toThrow(/nome inválido/);
    await expect(library.remove('skill', '..')).rejects.toThrow(/nome inválido/);
    await expect(library.install('agent', ['../../x'])).rejects.toThrow(/nome inválido/);
    await expect(library.create('agent', '../..')).rejects.toThrow(/nome inválido/);
  });

  it('responde pelo RPC resources.*', async () => {
    const changes: number[] = [];
    const library = new ResourceLibrary({
      dir,
      sources: () => roots,
      onChange: () => changes.push(1),
    });
    await library.init();
    const router = new Router();
    library.register(router);
    const call = (method: string, params?: unknown): Promise<unknown> =>
      router.dispatch(method, params, {} as never);

    expect(await call('resources.list')).toMatchObject({ dir, agents: [] });
    expect(
      await call('resources.install', { kind: 'skill', names: ['pdf'], fonte: 'base' }),
    ).toMatchObject([{ name: 'pdf', fonte: 'base' }]);
    expect(await call('resources.remove', { kind: 'skill', name: 'pdf' })).toBe(true);
    expect(await call('resources.create', { kind: 'agent', name: 'Novo' })).toMatchObject({
      name: 'novo',
    });
    expect(await call('resources.get', { kind: 'agent', name: 'novo' })).toMatchObject({
      info: { name: 'novo' },
    });
    expect(await call('resources.catalog')).toMatchObject({ agents: [{ name: 'revisor' }] });
    await expect(call('resources.get', { kind: 'outro', name: 'novo' })).rejects.toThrow(/kind/);
    await expect(
      call('resources.install', { kind: 'agent', names: ['revisor'], fonte: 3 }),
    ).rejects.toThrow(/fonte/);
    expect(changes).toHaveLength(3);
  });

  it('lê da fonte o que não está instalado, sem instalar', async () => {
    const library = await open();
    await library.install('skill', ['pdf']);

    const got = await library.get('agent', 'revisor');
    expect(got.instalado).toBe(false);
    expect(got.info).toMatchObject({ origem: 'fonte', fonte: 'base', perfil: 'claude-sonnet' });
    expect(got.info.path).toBe(join(catalog, 'agents', 'revisor.md'));
    expect(got.content).toContain('Você é o agente revisor.');
    expect((await library.list()).agents).toEqual([]);
    expect((await library.get('skill', 'pdf')).instalado).toBe(true);
    await expect(library.get('agent', 'nenhum')).rejects.toThrow(/find_resources/);
    await expect(library.get('agent', '../revisor')).rejects.toThrow(/nome inválido/);
  });

  it('funciona sem nenhuma fonte', async () => {
    const library = new ResourceLibrary({ dir });
    await library.init();
    expect(await library.list()).toEqual({ agents: [], skills: [], dir });
    expect(await library.catalog()).toEqual({ agents: [], skills: [] });
    await expect(library.install('agent', ['revisor'])).rejects.toThrow(
      /nenhuma fonte de recursos cadastrada/,
    );
    await expect(library.get('agent', 'revisor')).rejects.toThrow(/fontes de recursos/);
  });
});

describe('sincronização com Claude Code, Codex e Gemini CLI', () => {
  let root: string;
  let library: ResourceLibrary;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-sync-'));
    await writeCatalog(join(root, 'catalog'));
    library = new ResourceLibrary({
      dir: join(root, 'resources'),
      sources: () => [{ id: 'base', nome: 'Base', dir: join(root, 'catalog') }],
    });
    await library.init();
    await library.install('agent', ['revisor']);
    await library.install('skill', ['pdf']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('instala agentes como subagentes e skills como pastas, com manifesto', async () => {
    const target = join(root, 'claude');
    await syncResources(target, await library.list());
    const agent = await readFile(join(target, 'agents', 'revisor.md'), 'utf8');
    expect(agent).toMatch(/^---\nname: revisor\ndescription: Revisa diffs com foco em bugs.\n/);
    expect(agent).toContain('model: sonnet');
    expect(agent).not.toContain('fakl:');
    expect(agent).toContain('Você é o agente revisor.');
    expect(await exists(join(target, 'skills', 'pdf', 'LICENSE.txt'))).toBe(true);
    expect(JSON.parse(await readFile(join(target, RESOURCE_MANIFEST), 'utf8'))).toEqual({
      agents: ['revisor'],
      skills: ['pdf'],
      skillFiles: { pdf: ['LICENSE.txt', 'SKILL.md'] },
    });
  });

  it('não apaga nem sobrescreve arquivos do usuário fora do manifesto', async () => {
    const target = join(root, 'claude');
    await mkdir(join(target, 'agents'), { recursive: true });
    await mkdir(join(target, 'skills', 'pdf'), { recursive: true });
    await writeFile(join(target, 'agents', 'meu.md'), 'meu agente');
    await writeFile(join(target, 'skills', 'pdf', 'SKILL.md'), 'skill do usuário');

    const logs: string[] = [];
    await syncResources(target, await library.list(), (m) => logs.push(m));
    expect(await readFile(join(target, 'skills', 'pdf', 'SKILL.md'), 'utf8')).toBe(
      'skill do usuário',
    );
    expect(logs.some((m) => m.includes('pdf'))).toBe(true);
    expect(JSON.parse(await readFile(join(target, RESOURCE_MANIFEST), 'utf8'))).toEqual({
      agents: ['revisor'],
      skills: [],
      skillFiles: {},
    });

    // Removido da biblioteca: some só o que é nosso.
    await library.remove('agent', 'revisor');
    await syncResources(target, await library.list());
    expect(await exists(join(target, 'agents', 'revisor.md'))).toBe(false);
    expect(await readFile(join(target, 'agents', 'meu.md'), 'utf8')).toBe('meu agente');
    expect(await readFile(join(target, 'skills', 'pdf', 'SKILL.md'), 'utf8')).toBe(
      'skill do usuário',
    );
    expect(await exists(join(target, RESOURCE_MANIFEST))).toBe(false);
  });

  it('ignora nomes com path traversal até quando vierem de um manifesto adulterado', async () => {
    const target = join(root, 'claude');
    const victimAgent = join(root, 'victim.md');
    const victimSkill = join(root, 'victim-skill');
    await mkdir(victimSkill, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(victimAgent, 'arquivo do usuário');
    await writeFile(join(victimSkill, 'SKILL.md'), 'skill do usuário');
    await writeFile(
      join(target, RESOURCE_MANIFEST),
      JSON.stringify({ agents: ['../../victim'], skills: ['../../victim-skill'] }),
    );

    await syncResources(target, { agents: [], skills: [] });

    expect(await readFile(victimAgent, 'utf8')).toBe('arquivo do usuário');
    expect(await readFile(join(victimSkill, 'SKILL.md'), 'utf8')).toBe('skill do usuário');

    await writeFile(
      join(target, RESOURCE_MANIFEST),
      JSON.stringify({
        agents: [],
        skills: ['pdf'],
        skillFiles: { pdf: ['../../victim.md'] },
      }),
    );
    await syncResources(target, { agents: [], skills: [] });
    expect(await readFile(victimAgent, 'utf8')).toBe('arquivo do usuário');
  });

  it('mantém a cópia anterior quando a origem falha durante a sincronização', async () => {
    const target = join(root, 'claude');
    const items = await library.list();
    await syncResources(target, items);
    const installed = join(target, 'agents', 'revisor.md');
    const previous = await readFile(installed, 'utf8');
    await rm(join(root, 'resources', 'agents', 'revisor.md'));

    const logs: string[] = [];
    await syncResources(target, items, (message) => logs.push(message));

    expect(await readFile(installed, 'utf8')).toBe(previous);
    expect(logs.some((message) => message.includes('revisor'))).toBe(true);
    expect(JSON.parse(await readFile(join(target, RESOURCE_MANIFEST), 'utf8'))).toMatchObject({
      agents: ['revisor'],
    });
  });

  it('não altera outro arquivo alcançado por hardlink de um agente gerenciado', async () => {
    const target = join(root, 'claude');
    await syncResources(target, await library.list());
    const installed = join(target, 'agents', 'revisor.md');
    const userFile = join(root, 'arquivo-do-usuario.md');
    await writeFile(userFile, 'conteúdo do usuário');
    await rm(installed);
    await link(userFile, installed);
    await writeFile(
      join(root, 'resources', 'agents', 'revisor.md'),
      agentFile('revisor', 'versão atualizada', '  nivel: pesado'),
    );

    await syncResources(target, await library.list());

    expect(await readFile(userFile, 'utf8')).toBe('conteúdo do usuário');
    expect(await readFile(installed, 'utf8')).toContain('versão atualizada');
  });

  it('não apaga uma pasta do usuário que substituiu um agente gerenciado', async () => {
    const target = join(root, 'claude');
    await syncResources(target, await library.list());
    const installed = join(target, 'agents', 'revisor.md');
    await rm(installed);
    await mkdir(installed);
    await writeFile(join(installed, 'meu-arquivo.md'), 'conteúdo do usuário');
    await writeFile(
      join(root, 'resources', 'agents', 'revisor.md'),
      agentFile('revisor', 'versão atualizada', '  nivel: pesado'),
    );

    await syncResources(target, await library.list());

    expect(await readFile(join(installed, 'meu-arquivo.md'), 'utf8')).toBe('conteúdo do usuário');
    const manifest = JSON.parse(await readFile(join(target, RESOURCE_MANIFEST), 'utf8')) as {
      agents: string[];
    };
    expect(manifest.agents).not.toContain('revisor');

    await writeFile(
      join(target, RESOURCE_MANIFEST),
      JSON.stringify({ agents: ['revisor'], skills: [], skillFiles: {} }),
    );
    await syncResources(target, { agents: [], skills: [] });
    expect(await readFile(join(installed, 'meu-arquivo.md'), 'utf8')).toBe('conteúdo do usuário');
  });

  it('serializa sincronizações paralelas da mesma pasta na ordem das chamadas', async () => {
    const target = join(root, 'claude');
    await syncResources(target, await library.list());
    await writeFile(join(root, 'resources', 'skills', 'pdf', 'grande.txt'), 'x'.repeat(2_000_000));
    const updated = await library.list();

    await Promise.all([
      syncResources(target, updated),
      syncResources(target, { agents: [], skills: [] }),
    ]);

    expect(await exists(join(target, 'agents', 'revisor.md'))).toBe(false);
    expect(await exists(join(target, 'skills', 'pdf'))).toBe(false);
    expect(await exists(join(target, RESOURCE_MANIFEST))).toBe(false);
  });

  it('atualiza skills que são nossas e leva só skills ao Codex', async () => {
    const codex = join(root, 'codex');
    const { skills } = await library.list();
    await syncResources(codex, { agents: [], skills });
    expect(await exists(join(codex, 'agents'))).toBe(false);
    await writeFile(join(codex, 'skills', 'pdf', 'anotacoes.md'), 'arquivo do usuário');
    await writeFile(join(root, 'resources', 'skills', 'pdf', 'SKILL.md'), 'versão 2');
    await rm(join(root, 'resources', 'skills', 'pdf', 'LICENSE.txt'));
    await syncResources(codex, { agents: [], skills: (await library.list()).skills });
    expect(await readFile(join(codex, 'skills', 'pdf', 'SKILL.md'), 'utf8')).toBe('versão 2');
    expect(await exists(join(codex, 'skills', 'pdf', 'LICENSE.txt'))).toBe(false);
    expect(await readFile(join(codex, 'skills', 'pdf', 'anotacoes.md'), 'utf8')).toBe(
      'arquivo do usuário',
    );
    expect(JSON.parse(await readFile(join(codex, RESOURCE_MANIFEST), 'utf8'))).toMatchObject({
      skills: ['pdf'],
      skillFiles: { pdf: ['SKILL.md'] },
    });

    await library.remove('skill', 'pdf');
    await syncResources(codex, { agents: [], skills: [] });
    expect(await exists(join(codex, 'skills', 'pdf', 'SKILL.md'))).toBe(false);
    expect(await readFile(join(codex, 'skills', 'pdf', 'anotacoes.md'), 'utf8')).toBe(
      'arquivo do usuário',
    );
    expect(await exists(join(codex, RESOURCE_MANIFEST))).toBe(false);
  });

  it('leva agentes e skills ao Gemini CLI no formato dele', async () => {
    const gemini = join(root, 'home', '.gemini');
    await writeFile(
      join(root, 'resources', 'agents', 'gemini.flash.md'),
      agentFile('gemini.flash', 'Triagem rápida.', '  modelo: gemini-3.8-flash'),
    );
    await syncResources(gemini, await library.list(), undefined, 'gemini');

    const agent = await readFile(join(gemini, 'agents', 'revisor.md'), 'utf8');
    expect(agent).toMatch(/^---\nname: revisor\ndescription: Revisa diffs com foco em bugs.\n---/);
    expect(agent).not.toContain('model:');
    expect(agent).toContain('Você é o agente revisor.');
    const flash = await readFile(join(gemini, 'agents', 'gemini.flash.md'), 'utf8');
    expect(flash).toContain('name: gemini-flash\n');
    expect(flash).toContain('model: gemini-3.8-flash');
    expect(await readFile(join(gemini, 'skills', 'pdf', 'SKILL.md'), 'utf8')).toContain(
      'Use pdftotext.',
    );
    expect(JSON.parse(await readFile(join(gemini, RESOURCE_MANIFEST), 'utf8'))).toMatchObject({
      agents: ['gemini.flash', 'revisor'],
      skills: ['pdf'],
    });
    const [first] = (await library.list()).agents;
    if (!first) throw new Error('falta o agente');
    expect(geminiSubagent(first, '---\nname: x\n---\ncorpo')).toMatch(/corpo$/);
  });

  it('deriva a pasta de cada CLI do provedor e do ambiente', () => {
    const home = join(root, 'home');
    expect(providerSyncTarget('anthropic', {}, home)).toEqual({
      dir: join(home, '.claude'),
      agents: 'claude',
    });
    expect(providerSyncTarget('anthropic', { CLAUDE_CONFIG_DIR: '/conta-2' }, home)?.dir).toBe(
      '/conta-2',
    );
    expect(providerSyncTarget('openai', {}, home)).toEqual({ dir: join(home, '.codex') });
    expect(providerSyncTarget('openai', { CODEX_HOME: '/codex' }, home)?.dir).toBe('/codex');
    expect(providerSyncTarget('google', {}, home)).toEqual({
      dir: join(home, '.gemini'),
      agents: 'gemini',
    });
    expect(providerSyncTarget('google', { GEMINI_CLI_HOME: '/g' }, home)?.dir).toBe(
      join('/g', '.gemini'),
    );
    expect(providerSyncTarget('ollama', {}, home)).toBeUndefined();
    expect(providerSyncTarget('acp', {}, home)).toBeUndefined();
  });

  it('sincroniza as três CLIs e, ao mudar a biblioteca, só as pastas que já existem', async () => {
    const home = join(root, 'home');
    const sync = new ResourceSync({ items: () => library.list() });
    const claude = providerSyncTarget('anthropic', {}, home);
    const codex = providerSyncTarget('openai', {}, home);
    const gemini = providerSyncTarget('google', {}, home);
    if (!claude || !codex || !gemini) throw new Error('alvos faltando');

    await sync.sync(claude);
    await sync.sync(codex);
    expect(await exists(join(home, '.claude', 'agents', 'revisor.md'))).toBe(true);
    expect(await exists(join(home, '.claude', 'skills', 'pdf', 'SKILL.md'))).toBe(true);
    expect(await exists(join(home, '.codex', 'skills', 'pdf', 'SKILL.md'))).toBe(true);
    expect(await exists(join(home, '.codex', 'agents'))).toBe(false);

    // Gemini configurado mas sem ~/.gemini: a CLI não foi usada, nada é criado.
    await library.remove('skill', 'pdf');
    await sync.refresh([claude, codex, gemini]);
    expect(await exists(join(home, '.gemini'))).toBe(false);
    expect(await exists(join(home, '.claude', 'skills', 'pdf'))).toBe(false);
    expect(await exists(join(home, '.codex', 'skills', 'pdf'))).toBe(false);

    // Com a pasta criada pela CLI, a próxima mudança chega lá também.
    await mkdir(join(home, '.gemini'), { recursive: true });
    await library.install('skill', ['pdf']);
    await sync.refresh([claude, codex, gemini]);
    expect(await exists(join(home, '.gemini', 'agents', 'revisor.md'))).toBe(true);
    expect(await exists(join(home, '.gemini', 'skills', 'pdf', 'SKILL.md'))).toBe(true);
    expect(await exists(join(home, '.claude', 'skills', 'pdf', 'SKILL.md'))).toBe(true);
  });

  it('escolhe o alias de modelo do Claude', () => {
    const base = {
      kind: 'agent',
      name: 'x',
      description: '',
      origem: 'usuario',
      path: '',
    } as const;
    expect(claudeModelAlias({ ...base, modelo: 'claude-opus-5-5' })).toBe('opus');
    expect(claudeModelAlias({ ...base, perfil: 'claude-haiku' })).toBe('haiku');
    expect(claudeModelAlias({ ...base, modelo: 'gpt-5-codex', perfil: 'codex' })).toBeUndefined();
  });
});

describe('recursos no prompt do maestro', () => {
  const task = {
    id: 'tarefa-1',
    titulo: 'Implementar',
    repoPath: '/repo',
    status: 'nova',
    criadaEm: '2026-10-13T00:00:00.000Z',
    runs: [],
  } as const;
  const resources: ResourceSummary = {
    agents: [
      {
        kind: 'agent',
        name: 'revisor',
        description: `Revisa diffs. ${'muito longo '.repeat(30)}`,
        nivel: 'padrao',
        perfil: 'claude-sonnet',
        origem: 'fonte',
        path: '/x/revisor.md',
      },
    ],
    skills: [
      {
        kind: 'skill',
        name: 'pdf',
        description: 'Lê PDFs.',
        nivel: 'leve',
        origem: 'fonte',
        path: '/x/pdf/SKILL.md',
      },
    ],
  };

  it('lista os recursos instalados e orienta o get_resource', () => {
    const prompt = maestroPrompt({
      task,
      limits: {},
      branch: 'b',
      base: 'main',
      profiles: [],
      resources,
    });
    expect(prompt).toContain('Agentes e skills instalados na IDE');
    expect(prompt).toContain('- revisor — padrao/claude-sonnet — Revisa diffs.');
    expect(prompt).toContain('- pdf — leve — Lê PDFs.');
    expect(prompt).toContain('get_resource');
    const line = prompt.split('\n').find((l) => l.startsWith('- revisor'));
    expect(line?.length).toBeLessThan(200);
    expect(line?.endsWith('…')).toBe(true);
    expect(chatMaestroPrompt(resources)).toContain('- pdf — leve — Lê PDFs.');
  });

  it('some com a lista quando a biblioteca está vazia', () => {
    const prompt = maestroPrompt({ task, limits: {}, branch: 'b', base: 'main', profiles: [] });
    expect(prompt).not.toContain('instalados na IDE (');
    expect(prompt).not.toContain('lista abaixo');
    // Nada instalado e nenhuma fonte: o maestro nem ouve falar de recursos.
    const empty = chatMaestroPrompt({ agents: [], skills: [] });
    expect(empty).not.toContain('instalados na IDE');
    expect(empty).not.toContain('find_resources com a subtarefa');
    expect(
      maestroPrompt({
        task,
        limits: {},
        branch: 'b',
        base: 'main',
        profiles: [],
        resources: { agents: [], skills: [] },
      }),
    ).not.toContain('Agentes, skills e servidores MCP:');
    // Com fontes e nada instalado: sem lista, mas com o guia (as fontes valem sem instalar).
    const withSources = chatMaestroPrompt({ agents: [], skills: [], disponiveis: 12 });
    expect(withSources).not.toContain('instalados na IDE');
    expect(withSources).toContain('find_resources com a subtarefa');
    expect(chatMaestroPrompt({ ...resources, disponiveis: 3 })).toContain(
      'há mais nas fontes de recursos',
    );
    expect(chatMaestroPrompt(resources)).not.toContain('há mais nas fontes');
    expect(chatMaestroPrompt()).not.toContain('lista abaixo');
    expect(chatMaestroPrompt()).not.toContain('find_resources com a subtarefa');
  });

  it('limita a lista sem esconder por completo agentes ou skills', () => {
    const info = (kind: 'agent' | 'skill', index: number) => ({
      kind,
      name: `${kind}-${String(index).padStart(3, '0')}`,
      description: 'x'.repeat(500),
      perfil: 'p'.repeat(500),
      origem: 'usuario' as const,
      path: `/x/${kind}/${String(index)}`,
    });
    const many: ResourceSummary = {
      agents: Array.from({ length: 100 }, (_, index) => info('agent', index)),
      skills: Array.from({ length: 100 }, (_, index) => info('skill', index)),
    };

    const prompt = chatMaestroPrompt(many);

    expect(prompt.match(/^- agent-/gm)).toHaveLength(32);
    expect(prompt.match(/^- skill-/gm)).toHaveLength(32);
    expect(prompt).toContain('136 recursos omitidos');
    // Inclui o guia de find_resources e spawn_agent com agente e skills.
    expect(prompt.length).toBeLessThan(17_000);
  });

  it('lista os servidores MCP e orienta buscar e injetar recursos', () => {
    const prompt = maestroPrompt({
      task,
      limits: {},
      branch: 'b',
      base: 'main',
      profiles: [],
      resources: {
        ...resources,
        mcps: [
          { name: 'github', categoria: 'Código', description: 'Issues e PRs.' },
          { name: 'sentry', description: 'Erros.', faltando: ['sentry-token'] },
        ],
      },
    });
    expect(prompt).toContain('- find_resources:');
    expect(prompt).toContain('passe `agente` e `skills` no spawn_agent');
    expect(prompt).toContain('Servidores MCP instalados na IDE');
    expect(prompt).toContain('- github — Código — Issues e PRs.');
    expect(prompt).toContain('- sentry — Erros. (falta o segredo sentry-token)');
  });

  it('injeta agente e skill no prompt do subagente, sem o frontmatter', () => {
    const [agent] = resources.agents;
    const [skill] = resources.skills;
    if (!agent || !skill) throw new Error('faltam recursos de exemplo');
    const prompt = workerPrompt(task, 'executor', undefined, [
      { info: agent, content: '---\nname: revisor\n---\n\nProcure bugs.\n' },
      { info: skill, content: '---\nname: pdf\n---\n\nUse pdftotext.\n' },
    ]);
    expect(prompt).toContain('Agente "revisor"');
    expect(prompt).toContain('Procure bugs.');
    expect(prompt).toContain('Skill "pdf"');
    expect(prompt).toContain('Use pdftotext.');
    expect(prompt).not.toContain('name: revisor');
    expect(resourcesBriefing([])).toBe('');
  });

  it('expõe a ferramenta get_resource ao maestro', () => {
    expect(MAESTRO_TOOLS.find((tool) => tool.name === 'get_resource')?.method).toBe(
      'resources.get',
    );
  });
});
