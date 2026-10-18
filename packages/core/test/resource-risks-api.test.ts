import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpCatalog, ResourceCatalog, ResourceInfo } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { CoreClient, createCore, createSessionToken, ResourceRiskScanner } from '../src/index.js';
import { testSocket } from './helpers.js';
import { BENIGNO, SUSPEITO } from './fixtures/varredura.js';

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Fonte local sintética: um item benigno e um suspeito de cada tipo. */
async function writeSource(dir: string): Promise<void> {
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(join(dir, 'agents', 'revisor.md'), BENIGNO.agenteRevisor);
  await writeFile(
    join(dir, 'agents', 'sorrateiro.md'),
    `---\nname: sorrateiro\ndescription: Parece inofensivo.\n---\n\n${SUSPEITO.injecaoEn}\n${SUSPEITO.injecaoPt2}\n`,
  );
  await mkdir(join(dir, 'skills', 'clima'), { recursive: true });
  await writeFile(join(dir, 'skills', 'clima', 'SKILL.md'), BENIGNO.skillApi);
  await mkdir(join(dir, 'skills', 'instalador', 'scripts'), { recursive: true });
  await writeFile(
    join(dir, 'skills', 'instalador', 'SKILL.md'),
    '---\nname: instalador\ndescription: Prepara o ambiente.\n---\n\nRode scripts/setup.sh.\n',
  );
  await writeFile(
    join(dir, 'skills', 'instalador', 'scripts', 'setup.sh'),
    `#!/bin/sh\n${SUSPEITO.curlSh}\n`,
  );
  await writeFile(
    join(dir, 'mcps.json'),
    JSON.stringify({
      servers: {
        relogio: { ...BENIGNO.mcpPinado, fakl: { descricao: 'Hora' } },
        remoto: BENIGNO.mcpHttp,
        shell: SUSPEITO.mcpShell,
        tunel: SUSPEITO.mcpTunel,
        livre: SUSPEITO.mcpNpxLivre,
      },
    }),
  );
}

describe('Core: varredura de recursos pela API', { timeout: 30_000 }, () => {
  it('lista os riscos no catálogo, nunca bloqueia a instalação e entrega os achados', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fakl-riscos-'));
    const socket = await testSocket();
    const token = createSessionToken();
    const core = createCore({ socketPath: socket.path, token, configHome: home });
    await core.start();
    const client = await CoreClient.connect(socket.path, token, 'test');
    try {
      const folder = join(home, 'fonte');
      await writeSource(folder);
      await client.request('sources.add', { caminho: folder, nome: 'Fonte' });

      const catalog = await client.request<ResourceCatalog>('resources.catalog');
      const byName = (items: ResourceCatalog['agents']) =>
        Object.fromEntries(items.map((item) => [item.name, item.riscos]));
      const agents = byName(catalog.agents);
      const skills = byName(catalog.skills);
      expect(agents.revisor).toEqual([]);
      expect(agents.sorrateiro).toMatchObject([
        { regra: 'prompt-injection', severidade: 'alta', arquivo: 'sorrateiro.md', linha: 6 },
        { regra: 'prompt-injection', severidade: 'alta', linha: 7 },
      ]);
      // A skill de exemplo com `curl` e `.env.example` não passa de baixa.
      expect(skills.clima?.every((risk) => risk.severidade === 'baixa')).toBe(true);
      expect(skills.instalador).toMatchObject([
        { regra: 'baixa-e-executa', severidade: 'alta', arquivo: 'scripts/setup.sh', linha: 2 },
      ]);

      const mcps = await client.request<McpCatalog>('mcps.catalog');
      const mcp = Object.fromEntries(mcps.servers.map((server) => [server.name, server.riscos]));
      expect(mcp.relogio).toEqual([]);
      expect(mcp.remoto).toEqual([]);
      expect(mcp.shell).toMatchObject([{ regra: 'mcp-shell', severidade: 'alta' }]);
      expect(mcp.tunel).toMatchObject([{ regra: 'mcp-dominio-estranho', severidade: 'alta' }]);
      expect(mcp.livre).toMatchObject([{ regra: 'mcp-sem-versao', severidade: 'baixa' }]);

      // A instalação segue o fluxo de sempre; o resultado carrega os achados.
      const agentsInstalled = await client.request<ResourceInfo[]>('resources.install', {
        kind: 'agent',
        names: ['revisor', 'sorrateiro'],
        fonte: 'fonte',
      });
      expect(agentsInstalled.map((info) => [info.name, info.riscos?.length])).toEqual([
        ['revisor', 0],
        ['sorrateiro', 2],
      ]);
      const skillsInstalled = await client.request<ResourceInfo[]>('resources.install', {
        kind: 'skill',
        names: ['instalador'],
        fonte: 'fonte',
      });
      expect(skillsInstalled[0]?.riscos).toMatchObject([{ regra: 'baixa-e-executa' }]);
      expect(await exists(join(home, '.fakl', 'resources', 'agents', 'sorrateiro.md'))).toBe(true);
      expect(
        await exists(
          join(home, '.fakl', 'resources', 'skills', 'instalador', 'scripts', 'setup.sh'),
        ),
      ).toBe(true);

      const installed = await client.request<{
        servers: { name: string; riscos?: { regra: string }[] }[];
      }>('mcps.install', { names: ['relogio', 'shell'], fonte: 'fonte' });
      expect(installed.servers.map((server) => [server.name, server.riscos?.length])).toEqual([
        ['relogio', 0],
        ['shell', 1],
      ]);

      // `resources.list` e `mcps.list` não repetem a varredura.
      const list = await client.request<{ agents: ResourceInfo[] }>('resources.list');
      expect(list.agents.every((info) => info.riscos === undefined)).toBe(true);
    } finally {
      client.close();
      await core.stop();
      await socket.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('ResourceRiskScanner', () => {
  it('reaproveita o resultado por hash do conteúdo e revarre quando o arquivo muda', () => {
    const scanner = new ResourceRiskScanner();
    const file = (conteudo: string) => [{ caminho: 'SKILL.md', conteudo }];
    const first = scanner.scan('skill', 'a', file(SUSPEITO.curlSh));
    expect(scanner.scan('skill', 'a', file(SUSPEITO.curlSh))).toBe(first);
    expect(scanner.scan('skill', 'a', file('texto limpo'))).toEqual([]);
    expect(scanner.scan('skill', 'a', file(SUSPEITO.curlSh))).toBe(first);
  });
});
