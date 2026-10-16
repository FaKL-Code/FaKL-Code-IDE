import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  McpLibrary,
  rankResources,
  registerResourceFinder,
  ResourceLibrary,
  Router,
  searchTokens,
  type SearchItem,
} from '../src/index.js';

const item = (
  kind: SearchItem['kind'],
  name: string,
  description: string,
  extra: Partial<SearchItem> = {},
): SearchItem => ({ kind, name, description, instalado: true, ...extra });

describe('busca de recursos', () => {
  const items: SearchItem[] = [
    item('agent', 'debugger', 'Diagnóstico e correção de bugs e testes falhando.'),
    item('agent', 'test-automator', 'Cria suítes de teste unitário e E2E.'),
    item('skill', 'tdd', 'Teste primeiro, red-green-refactor.'),
    item('agent', 'docs-writer', 'Documentação técnica: README e guias.'),
    item('mcp', 'atlassian', 'Jira e Confluence.', { categoria: 'Gestão', instalado: false }),
    item('agent', 'security-auditor', 'Auditoria de segurança: OWASP e autenticação.'),
  ];

  it('tira acentos e palavras vazias', () => {
    expect(searchTokens('Use quando a Correção de SEGURANÇA for urgente')).toEqual([
      'correcao',
      'seguranca',
      'urgente',
    ]);
  });

  it('acha pelo sentido em português e pelo nome em inglês', () => {
    expect(rankResources('depurar teste falhando', items)[0]?.name).toBe('debugger');
    expect(rankResources('revisar a segurança do login', items)[0]?.name).toBe('security-auditor');
    expect(rankResources('atualizar documentação', items)[0]?.name).toBe('docs-writer');
  });

  it('acha servidores MCP do catálogo', () => {
    const hits = rankResources('consultar issues do Jira', items);
    expect(hits[0]).toMatchObject({ kind: 'mcp', name: 'atlassian', instalado: false });
  });

  it('respeita o limite e ignora tarefa vazia', () => {
    expect(rankResources('teste', items, 1)).toHaveLength(1);
    expect(rankResources('o de para', items)).toEqual([]);
  });
});

describe('resources.find', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fakl-finder-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('busca nas fontes, na biblioteca e nos servidores MCP', async () => {
    const catalog = join(root, 'catalog');
    await mkdir(join(catalog, 'agents'), { recursive: true });
    await writeFile(
      join(catalog, 'agents', 'sql-pro.md'),
      '---\nname: sql-pro\ndescription: Consultas SQL lentas e índices.\nfakl:\n  padrao: false\n  perfil: codex\n---\n',
    );
    await writeFile(
      join(catalog, 'mcps.json'),
      JSON.stringify({
        servers: {
          postgres: {
            command: 'npx',
            args: ['pg'],
            fakl: { descricao: 'Banco PostgreSQL só leitura.', categoria: 'Dados' },
          },
          // Bloco fakl malformado não derruba a busca.
          torto: { command: 'npx', args: ['t'], fakl: { descricao: 42, categoria: ['x'] } },
        },
      }),
    );
    const sources = () => [{ id: 'base', nome: 'Base', dir: catalog }];
    const resources = new ResourceLibrary({ dir: join(root, 'resources'), sources });
    await resources.init();
    await resources.create('skill', 'Minha skill', 'Explica consultas SQL do time.');
    const mcps = new McpLibrary({
      file: join(root, 'mcp.json'),
      sources,
      vault: { has: () => false, get: () => undefined } as never,
    });
    const router = new Router();
    registerResourceFinder(router, { resources, mcps });
    const find = (params: unknown): Promise<unknown> =>
      router.dispatch('resources.find', params, {} as never);

    const hits = (await find({ tarefa: 'otimizar consulta SQL no banco' })) as {
      kind: string;
      name: string;
      instalado: boolean;
    }[];
    expect(hits.map((h) => `${h.kind}:${h.name}:${String(h.instalado)}`)).toEqual(
      expect.arrayContaining([
        'agent:sql-pro:false',
        'skill:minha-skill:true',
        'mcp:postgres:false',
      ]),
    );
    expect(await find({ tarefa: 'banco postgres', tipos: ['mcp'] })).toMatchObject([
      { kind: 'mcp', name: 'postgres' },
    ]);
    // A versão instalada e editada vence a da fonte, inclusive no perfil.
    await resources.install('agent', ['sql-pro']);
    await writeFile(
      join(root, 'resources', 'agents', 'sql-pro.md'),
      '---\nname: sql-pro\ndescription: Consultas SQL do time.\nfakl:\n  perfil: claude-sonnet\n---\n',
    );
    expect(await find({ tarefa: 'consultas SQL', tipos: ['agent'] })).toMatchObject([
      { name: 'sql-pro', perfil: 'claude-sonnet', instalado: true },
    ]);
    await expect(find({ tarefa: 'x', tipos: ['outro'] })).rejects.toThrow(/tipo inválido/);
    await expect(find({})).rejects.toThrow(/tarefa/);
  });

  it('sem fontes, só acha o que o usuário criou', async () => {
    const resources = new ResourceLibrary({ dir: join(root, 'resources') });
    await resources.init();
    const mcps = new McpLibrary({
      file: join(root, 'mcp.json'),
      vault: { has: () => false, get: () => undefined } as never,
    });
    const router = new Router();
    registerResourceFinder(router, { resources, mcps });
    const find = (params: unknown): Promise<unknown> =>
      router.dispatch('resources.find', params, {} as never);
    expect(await find({ tarefa: 'otimizar consulta SQL' })).toEqual([]);
    await resources.create('agent', 'Consultor SQL', 'Otimiza consultas SQL.');
    expect(await find({ tarefa: 'otimizar consulta SQL' })).toMatchObject([
      { kind: 'agent', name: 'consultor-sql', instalado: true },
    ]);
  });
});
