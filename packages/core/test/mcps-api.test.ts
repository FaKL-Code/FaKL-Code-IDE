import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CoreClient, createCore, createSessionToken } from '../src/index.js';
import { testSocket } from './helpers.js';

interface Info {
  servers: { name: string; faltando: string[] }[];
  arquivo: string;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Fonte de pasta com um agente, uma skill e dois modelos de MCP. */
async function writeSource(dir: string): Promise<void> {
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(
    join(dir, 'agents', 'revisor.md'),
    '---\nname: revisor\ndescription: Revisa diffs.\nfakl:\n  perfil: claude-sonnet\n---\n\nCorpo.\n',
  );
  await mkdir(join(dir, 'skills', 'pdf'), { recursive: true });
  await writeFile(
    join(dir, 'skills', 'pdf', 'SKILL.md'),
    '---\nname: pdf\n---\n\nUse pdftotext.\n',
  );
  await writeFile(
    join(dir, 'mcps.json'),
    JSON.stringify({
      inputs: [{ id: 'github_pat', type: 'promptString', description: 'Token', password: true }],
      servers: {
        github: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ${input:github_pat}' },
          fakl: { descricao: 'GitHub' },
        },
        time: { command: 'uvx', args: ['mcp-server-time'], fakl: { descricao: 'Hora' } },
      },
    }),
  );
}

describe('Core: fontes, recursos e servidores MCP pela API', { timeout: 30_000 }, () => {
  it('abre sem nenhum recurso, instala de uma fonte e remove', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fakl-mcps-api-'));
    const socket = await testSocket();
    const token = createSessionToken();
    const core = createCore({ socketPath: socket.path, token, configHome: home });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    try {
      // Zero fontes: nada instalado, nada oferecido, nenhum erro.
      expect(await client.request('sources.list')).toEqual([]);
      expect(await client.request('resources.list')).toMatchObject({ agents: [], skills: [] });
      expect(await client.request('resources.catalog')).toEqual({ agents: [], skills: [] });
      expect(await client.request('mcps.catalog')).toEqual({ servers: [] });
      expect(await client.request('mcps.list')).toMatchObject({ servers: [] });
      expect(await client.request('resources.find', { tarefa: 'revisar diff' })).toEqual([]);
      expect(await exists(join(home, '.fakl', 'resources', 'agents', 'revisor.md'))).toBe(false);

      const folder = join(home, 'recursos');
      await writeSource(folder);
      expect(
        await client.request('sources.add', { caminho: folder, nome: 'Recursos' }),
      ).toMatchObject({ id: 'recursos', agents: 1, skills: 1, mcps: 2 });
      // Cadastrar não instala nada.
      expect(await client.request('resources.list')).toMatchObject({ agents: [], skills: [] });
      expect(await client.request('resources.find', { tarefa: 'revisar diff' })).toMatchObject([
        { kind: 'agent', name: 'revisor', instalado: false },
      ]);

      expect(
        await client.request('resources.install', {
          kind: 'agent',
          names: ['revisor'],
          fonte: 'recursos',
        }),
      ).toMatchObject([{ name: 'revisor', origem: 'fonte', fonte: 'recursos' }]);

      const catalog = await client.request<{ servers: { name: string; fonte: string }[] }>(
        'mcps.catalog',
      );
      expect(catalog.servers.map((s) => `${s.fonte}:${s.name}`)).toEqual([
        'recursos:github',
        'recursos:time',
      ]);
      let info = await client.request<Info>('mcps.install', {
        names: ['github', 'time'],
        fonte: 'recursos',
      });
      expect(info.servers.map((s) => [s.name, s.faltando])).toEqual([
        ['github', ['github_pat']],
        ['time', []],
      ]);
      expect(info.arquivo).toBe(join(home, '.fakl', 'mcp.json'));

      await client.request('secrets.set', { nome: 'mcp.github_pat', valor: 'segredo-de-teste' });
      info = await client.request<Info>('mcps.list');
      expect(info.servers.every((s) => s.faltando.length === 0)).toBe(true);
      expect(await readFile(info.arquivo, 'utf8')).not.toContain('segredo-de-teste');
      expect(await client.request('secrets.status')).toMatchObject({ 'mcp.github_pat': true });

      expect(await client.request('mcps.remove', { name: 'time' })).toBe(true);
      info = await client.request<Info>('mcps.list');
      expect(info.servers.map((s) => s.name)).toEqual(['github']);

      // Remover a fonte não desinstala o que veio dela.
      expect(await client.request('sources.remove', { id: 'recursos' })).toBe(true);
      expect(await client.request('resources.catalog')).toEqual({ agents: [], skills: [] });
      expect(await client.request('resources.list')).toMatchObject({
        agents: [{ name: 'revisor' }],
      });
      expect(JSON.parse(await readFile(join(home, '.fakl', 'sources.json'), 'utf8'))).toEqual({
        fontes: [],
      });
    } finally {
      client.close();
      await core.stop();
      await socket.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});
