import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Run, Task } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  conflictName,
  CoreClient,
  CoreRpcError,
  createCore,
  createSessionToken,
  EventBus,
  fold,
  parseConfig,
  parseNote,
  projectFolder,
  projectTag,
  upsertBlock,
  upsertInSection,
  VaultIndex,
  VaultService,
  VaultSync,
  type Core,
  type Orchestrator,
  type VaultConfig,
} from '../src/index.js';
import { testSocket } from './helpers.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function note(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

describe('notas', () => {
  it('lê frontmatter, título, tags, links e embeds', () => {
    const parsed = parseNote(
      'Projetos/FaKL.md',
      [
        '---',
        'tags: [ide, fakl/core]',
        'privado: false',
        '---',
        '# FaKL-Code',
        'Veja [[Decisões#Vault|as decisões]] e ![[diagrama.png]].',
        'Tag #agentes e não #123.',
        '```',
        '[[dentro-do-codigo]] #nao',
        '```',
      ].join('\n'),
    );
    expect(parsed.title).toBe('FaKL-Code');
    expect([...parsed.tags].sort()).toEqual(['agentes', 'fakl/core', 'ide']);
    expect(parsed.links).toEqual(['Decisões']);
    expect(parsed.embeds).toEqual(['diagrama.png']);
  });

  it('usa o nome do arquivo sem título', () => {
    expect(parseNote('Inbox/ideia solta.md', 'só texto').title).toBe('ideia solta');
  });

  it('dobra acentos', () => {
    expect(fold('Decisão Única')).toBe('decisao unica');
  });

  it('nomeia a cópia de conflito', () => {
    expect(conflictName('Diário/2026-10-12.md', 'mac')).toBe('Diário/2026-10-12 (conflito mac).md');
  });

  it('valida vault no config.yaml', () => {
    expect(parseConfig({ vault: '~/Vault' }, 'x').vault).toEqual({ caminho: '~/Vault' });
    expect(parseConfig({ vault: { caminho: 'v', remoto: 'r' } }, 'x').vault).toEqual({
      caminho: 'v',
      remoto: 'r',
    });
    expect(() => parseConfig({ vault: { remoto: 'r' } }, 'x')).toThrow(/caminho/);
  });
});

describe('índice do vault', () => {
  let root: string;
  let index: VaultIndex;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-vault-'));
    await note(root, 'Projetos/FaKL.md', '# FaKL\nLigado a [[Decisões]]. #ide');
    await note(root, 'Decisões.md', '---\ntags: [adr]\n---\nUsamos um índice em memória.');
    await note(root, 'Diário/2026-10-11.md', 'Falei das [[decisões]] hoje.');
    await note(
      root,
      'Pessoal/Senhas.md',
      '---\nprivado: true\n---\nNada de decisões aqui. [[Decisões]]',
    );
    await note(root, '.obsidian/workspace.md', 'ignorado');
    index = new VaultIndex(root);
    await index.build();
  });

  afterEach(async () => {
    index.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('indexa sem a pasta do Obsidian', () => {
    expect(index.size).toBe(4);
    expect(index.get('.obsidian/workspace.md')).toBeUndefined();
  });

  it('resolve links como o Obsidian, sem diferenciar maiúsculas', () => {
    expect(index.resolve('decisões')?.path).toBe('Decisões.md');
    expect(index.resolve('Projetos/FaKL')?.path).toBe('Projetos/FaKL.md');
  });

  it('acha backlinks e esconde os privados de agentes', () => {
    expect(
      index
        .backlinks('Decisões.md')
        .map((n) => n.path)
        .sort(),
    ).toEqual(['Diário/2026-10-11.md', 'Pessoal/Senhas.md', 'Projetos/FaKL.md']);
    expect(index.backlinks('Decisões.md', false).map((n) => n.path)).not.toContain(
      'Pessoal/Senhas.md',
    );
  });

  it('busca por palavra sem acento, tag e pasta', () => {
    const paths = (query: string, includePrivate = false): string[] =>
      index.search(query, { includePrivate }).map((hit) => hit.path);
    expect(paths('decisoes')[0]).toBe('Decisões.md');
    expect(paths('decisoes')).not.toContain('Pessoal/Senhas.md');
    expect(paths('decisoes', true)).toContain('Pessoal/Senhas.md');
    expect(paths('tag:adr')).toEqual(['Decisões.md']);
    expect(paths('#ide')).toEqual(['Projetos/FaKL.md']);
    expect(paths('pasta:Diário decisões')).toEqual(['Diário/2026-10-11.md']);
  });

  it('conta tags e monta o grafo', () => {
    expect(index.tags()).toMatchObject({ adr: 1, ide: 1 });
    const graph = index.graph(false);
    expect(graph.nodes.map((n) => n.path)).not.toContain('Pessoal/Senhas.md');
  });

  it('recusa caminhos fora da raiz', () => {
    expect(index.relative('../fora.md')).toBeUndefined();
    expect(index.relative('Inbox/nova.md')).toBe('Inbox/nova.md');
  });
});

describe('sincronização do vault', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fakl-vsync-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'remoto.git')]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const clone = (name: string): string => {
    const path = join(dir, name);
    execFileSync('git', ['clone', '-q', join(dir, 'remoto.git'), path]);
    git(path, 'checkout', '-q', '-B', 'main');
    git(path, 'config', 'core.autocrlf', 'false');
    return path;
  };

  it('leva notas de uma máquina à outra e guarda os dois lados num conflito', async () => {
    const mac = clone('mac');
    const pc = clone('pc');
    const syncMac = new VaultSync({ root: mac, machine: 'mac' });
    const syncPc = new VaultSync({ root: pc, machine: 'pc' });

    await note(mac, 'Inbox/ideia.md', 'linha original\n');
    expect(await syncMac.sync()).toMatchObject({ ok: true, changed: true });
    expect(await syncPc.sync()).toMatchObject({ ok: true, changed: true });
    expect(await readFile(join(pc, 'Inbox/ideia.md'), 'utf8')).toBe('linha original\n');

    await writeFile(join(mac, 'Inbox/ideia.md'), 'versão do mac\n');
    await writeFile(join(pc, 'Inbox/ideia.md'), 'versão do pc\n');
    expect((await syncMac.sync()).ok).toBe(true);
    const result = await syncPc.sync();
    expect(result).toMatchObject({ ok: true, conflicts: ['Inbox/ideia.md'] });
    expect(await readFile(join(pc, 'Inbox/ideia.md'), 'utf8')).toBe('versão do mac\n');
    expect(await readFile(join(pc, 'Inbox/ideia (conflito pc).md'), 'utf8')).toBe('versão do pc\n');

    await syncMac.sync();
    expect(existsSync(join(mac, 'Inbox/ideia (conflito pc).md'))).toBe(true);
    expect(git(pc, 'status', '--porcelain')).toBe('');
  }, 30_000);

  it('não sincroniza sem origin', async () => {
    const solo = join(dir, 'solo');
    execFileSync('git', ['init', '-q', solo]);
    expect(await new VaultSync({ root: solo }).enabled()).toBe(false);
  });
});

describe('serviço do vault', () => {
  let root: string;
  let bus: EventBus;
  let vault: VaultService;
  const tasks = new Map<string, Task>();
  const created: unknown[] = [];
  const orchestrator = {
    taskById: (id: string) => tasks.get(id),
    createTask: (definition: unknown) => {
      created.push(definition);
      return Promise.resolve({ id: 't1', ...(definition as object) } as Task);
    },
    startRun: () => Promise.resolve({ id: 'r1' } as Run),
  } as unknown as Orchestrator;

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'fakl-vsvc-')), 'Vault');
    bus = new EventBus();
    created.length = 0;
    const config: VaultConfig = { caminho: root };
    vault = new VaultService({
      bus,
      config: () => config,
      orchestrator,
      clock: () => new Date(2026, 9, 12, 9, 5),
    });
    await vault.open();
  });

  afterEach(async () => {
    vault.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it('cria a estrutura num vault novo', async () => {
    const folders = await readdir(root);
    expect(folders).toEqual(expect.arrayContaining(['Inbox', 'Diário', 'Agentes', 'Playbooks']));
    expect(vault.status()).toMatchObject({ ativo: true, caminho: root, sincroniza: false });
  });

  it('agentes escrevem só em Agentes/ e Projetos/', async () => {
    await expect(vault.write('Agentes/Memória/x', 'oi', 'substituir', true)).resolves.toEqual({
      path: 'Agentes/Memória/x.md',
    });
    await expect(vault.write('Inbox/x', 'oi', 'substituir', true)).rejects.toThrow(/só em/);
    await expect(vault.write('../fora', 'oi', 'substituir', false)).rejects.toThrow(/fora/);
    await vault.write('Agentes/Memória/x', 'mais', 'acrescentar', true);
    expect(await readFile(join(root, 'Agentes/Memória/x.md'), 'utf8')).toBe('oi\nmais\n');
  });

  it('esconde notas privadas de agentes', async () => {
    await vault.write('Projetos/segredo', '---\nprivado: true\n---\nchave', 'substituir', false);
    expect(() => vault.read('Projetos/segredo', true)).toThrow(/não encontrada/);
    expect(vault.read('Projetos/segredo', false)).toMatchObject({ path: 'Projetos/segredo.md' });
    await expect(vault.write('Projetos/segredo', 'x', 'substituir', true)).rejects.toThrow(
      /não encontrada/,
    );
  });

  it('cria a nota diária pelo template e acrescenta linhas', async () => {
    await note(root, 'Templates/Diário.md', '# Dia {{data}}\n\n');
    expect(await vault.daily()).toEqual({ path: 'Diário/2026-10-12.md' });
    await vault.appendDaily('fechei o vault');
    expect(await readFile(join(root, 'Diário/2026-10-12.md'), 'utf8')).toBe(
      '# Dia 2026-10-12\n\n- 09:05 fechei o vault\n',
    );
  });

  it('transforma playbook e nota em tarefa', async () => {
    await vault.write(
      'Playbooks/Revisar',
      '---\ntipo: playbook\nnome: revisar\nmaestro: claude\nentrega: pr\n---\nRevise {{repo}} inteiro.',
      'substituir',
      false,
    );
    expect(vault.playbooks().map((p) => p.nome)).toEqual(['revisar']);
    const task = vault.taskFromPlaybook(vault.playbook('revisar'), {
      titulo: 'Revisão',
      repoPath: '/src/meu-repo',
    });
    expect(task).toMatchObject({
      maestroProfileId: 'claude',
      entrega: 'pr',
      playbook: 'revisar',
    });
    expect(String(task.descricao)).toContain('Revise meu-repo inteiro.');

    await vault.write(
      'Projetos/Bug',
      '---\nrepo: /src/app\nplaybook: revisar\n---\n# Corrigir login\nO login cai.',
      'substituir',
      false,
    );
    const fromNote = vault.taskFromNote('Bug');
    expect(fromNote).toMatchObject({
      titulo: 'Corrigir login',
      repoPath: '/src/app',
      origem: 'nota',
      referencia: 'Projetos/Bug.md',
      playbook: 'revisar',
    });
  });

  it('grava uma nota por execução terminada', async () => {
    tasks.set('t9', {
      id: 't9',
      titulo: 'Criar README',
      descricao: 'Um README novo',
      repoPath: '/src/app',
      status: 'concluída',
      runs: ['r9'],
      criadaEm: '2026-10-12T09:00:00.000Z',
    } as unknown as Task);
    const run = {
      id: 'r9',
      taskId: 't9',
      status: 'concluída',
      resultado: 'merge',
      inicio: new Date(2026, 9, 12, 8, 30).toISOString(),
      agentes: [{ sessionId: 's1', profileId: 'claude', papel: 'maestro', profundidade: 0 }],
      rodadas: [{ numero: 1, veredito: 'passou', verificacoes: [{ nome: 'npm test', ok: true }] }],
      decisoes: [],
      resumo: 'Pronto.',
    } as unknown as Run;
    bus.publish('run.done', run.id, run);
    const file = join(root, 'Agentes/Sessões/2026-10-12 0830 Criar README.md');
    await expect.poll(() => existsSync(file)).toBe(true);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('tipo: sessao');
    expect(text).toContain('- claude (maestro)');
    expect(text).toContain('`npm test` ✓');
  });

  it('liga a execução ao projeto, ao devlog e ao diário sem duplicar', async () => {
    await vault.write('Projetos/Meu-App/Arquitetura', '# Arquitetura', 'substituir', false);
    tasks.set('t7', {
      id: 't7',
      titulo: 'Login com Google',
      repoPath: 'D:\\projetos\\meu-app',
      status: 'concluída',
      runs: ['r7'],
      criadaEm: '2026-10-12T09:00:00.000Z',
    } as unknown as Task);
    const run = {
      id: 'r7',
      taskId: 't7',
      status: 'concluída',
      resultado: 'pr',
      branch: 'fakl/t7/r7',
      inicio: new Date(2026, 9, 12, 8, 30).toISOString(),
      agentes: [],
      rodadas: [],
      decisoes: [
        {
          pergunta: 'Qual provedor?',
          opcoes: [{ id: 'a', rotulo: 'Firebase' }],
          escolha: 'a',
        },
      ],
      resumo: 'Login pronto.\n## Pendências\nTestes E2E.',
    } as unknown as Run;
    const session = 'Agentes/Sessões/2026-10-12 0830 Login com Google';
    const hub = join(root, 'Projetos/Meu-App/Meu-App.md');
    const devlog = join(root, 'Projetos/Meu-App/Devlog.md');
    const daily = join(root, 'Diário/2026-10-12.md');
    bus.publish('run.done', run.id, run);
    await expect.poll(() => existsSync(daily)).toBe(true);
    bus.publish('run.done', run.id, { ...run, resumo: 'Login pronto, revisado.' });
    await expect
      .poll(() => readFile(devlog, 'utf8').catch(() => ''))
      .toContain('Login pronto, revisado.');

    const note = await readFile(join(root, `${session}.md`), 'utf8');
    expect(note).toContain('projeto: "[[Projetos/Meu-App/Meu-App|Meu-App]]"');
    expect(note).toContain('tags: [fakl/sessao, projeto/meu-app]');
    expect(note).toContain('[[Projetos/Meu-App/Devlog|Devlog]] · Diário: [[Diário/2026-10-12]]');

    const hubText = await readFile(hub, 'utf8');
    expect(hubText).toContain('tipo: projeto');
    expect(hubText).toContain('- [[Projetos/Meu-App/Arquitetura|Arquitetura]]');
    expect(hubText.split(`[[${session}|`)).toHaveLength(2);
    expect(hubText).toMatch(/## Sessões\n\n- \[\[.+\]\] — pr\n$/);

    const devlogText = await readFile(devlog, 'utf8');
    expect(devlogText.split('<!-- execucao: r7 -->')).toHaveLength(2);
    expect(devlogText).not.toContain('Testes E2E');
    expect(devlogText).toContain('- Qual provedor? → Firebase');

    const dailyText = await readFile(daily, 'utf8');
    expect(dailyText.split(`[[${session}|`)).toHaveLength(2);
    expect(dailyText).toContain('em [[Projetos/Meu-App/Meu-App|Meu-App]] — pr');
  });
});

describe('memória dos projetos', () => {
  it('casa o repositório com a pasta que já existe', () => {
    expect(projectFolder('D:\\projetos\\fakl-code-ide', ['FaKL-Code-IDE', 'Outro'])).toBe(
      'FaKL-Code-IDE',
    );
    expect(projectFolder('/src/novo_app/', ['FaKL-Code-IDE'])).toBe('novo_app');
    expect(projectTag('FaKL Code IDE')).toBe('projeto/fakl-code-ide');
  });

  it('põe a linha no fim da seção, sem duplicar', () => {
    const text = '# P\n\n## Sessões\n\nNenhuma.\n\n## Outra\n\nx\n';
    const once = upsertInSection(text, 'Sessões', '- [[a|A]] — ok', '[[a|');
    expect(once).toBe('# P\n\n## Sessões\n\n- [[a|A]] — ok\n\n## Outra\n\nx\n');
    const twice = upsertInSection(once, 'Sessões', '- [[b|B]] — ok', '[[b|');
    expect(twice).toContain('- [[a|A]] — ok\n- [[b|B]] — ok\n\n## Outra');
    expect(upsertInSection(twice, 'Sessões', '- [[a|A]] — falhou', '[[a|')).toContain(
      '- [[a|A]] — falhou\n- [[b|B]]',
    );
    expect(upsertInSection('# P\n', 'Sessões', '- x')).toBe('# P\n\n## Sessões\n\n- x\n');
  });

  it('troca o bloco marcado do devlog', () => {
    const one = upsertBlock('# Devlog\n', '<!-- 1 -->', '## Um\n<!-- 1 -->\nprimeiro');
    const two = upsertBlock(one, '<!-- 2 -->', '## Dois\n<!-- 2 -->\nsegundo');
    expect(upsertBlock(two, '<!-- 1 -->', '## Um\n<!-- 1 -->\nnovo')).toBe(
      '# Devlog\n\n## Um\n<!-- 1 -->\nnovo\n\n## Dois\n<!-- 2 -->\nsegundo\n',
    );
  });
});

describe('Core: vault pela API', () => {
  let socket: Awaited<ReturnType<typeof testSocket>>;
  let core: Core;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fakl-vapi-'));
    await mkdir(join(home, '.fakl'), { recursive: true });
    await writeFile(join(home, '.fakl', 'config.yaml'), 'vault:\n  caminho: ~/Notas\n');
    socket = await testSocket();
  });

  afterEach(async () => {
    await core.stop();
    await socket.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  it('abre o vault da configuração e atende a IDE', async () => {
    const token = createSessionToken();
    core = createCore({
      socketPath: socket.path,
      token,
      configHome: home,
      agents: { home, profiles: [] },
    });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    try {
      expect(await client.request('vault.status')).toMatchObject({
        ativo: true,
        caminho: join(home, 'Notas'),
      });
      await client.request('vault.write', { caminho: 'Inbox/oi', conteudo: 'olá #teste' });
      expect(await client.request('vault.search', { consulta: 'ola' })).toMatchObject([
        { path: 'Inbox/oi.md' },
      ]);
      expect(await client.request('vault.tags')).toEqual({ teste: 1 });
      await expect(client.request('vault.read', { nota: 'nada' })).rejects.toBeInstanceOf(
        CoreRpcError,
      );
      const other = join(home, 'Outro');
      expect(await client.request('vault.configure', { caminho: other })).toMatchObject({
        ativo: true,
        caminho: other,
      });
      const saved = parse(await readFile(join(home, '.fakl', 'config.yaml'), 'utf8')) as unknown;
      expect(saved).toEqual({ vault: { caminho: other } });
      expect(await client.request('vault.configure', { caminho: null })).toMatchObject({
        ativo: false,
      });
    } finally {
      client.close();
    }
  });
});
