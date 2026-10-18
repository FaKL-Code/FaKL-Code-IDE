import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Run, Task } from '@fakl/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EventBus,
  mergeCriterio,
  VaultService,
  type Orchestrator,
  type VaultConfig,
} from '../src/index.js';
import { parseTaskDefinition } from '../src/orchestrator/orchestrator.js';

describe('critério do playbook (RF-208)', () => {
  let root: string;
  let vault: VaultService;
  const orchestrator = {
    taskById: () => undefined,
    createTask: (definition: unknown) =>
      Promise.resolve({ id: 't1', ...(definition as object) } as Task),
    startRun: () => Promise.resolve({ id: 'r1' } as Run),
  } as unknown as Orchestrator;
  const repoPath = process.platform === 'win32' ? 'C:\\src\\app' : '/src/app';

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'fakl-vpb-')), 'Vault');
    const config: VaultConfig = { caminho: root };
    vault = new VaultService({ bus: new EventBus(), config: () => config, orchestrator });
    await vault.open();
    await vault.write(
      'Playbooks/Completo',
      '---\ntipo: playbook\nnome: completo\ncriterio:\n  comandos: [pnpm lint, pnpm test]\n' +
        '  checklist: [Modo escuro funciona]\n  revisao: { perfil: revisor, exigeAprovacao: true }\n---\nFaça.',
      'substituir',
      false,
    );
    await vault.write(
      'Playbooks/Parcial',
      '---\ntipo: playbook\nnome: parcial\ncriterio:\n  comandos: [pnpm test]\n---\nFaça.',
      'substituir',
      false,
    );
    await vault.write(
      'Playbooks/Sem',
      '---\ntipo: playbook\nnome: sem\n---\nFaça.',
      'substituir',
      false,
    );
  });

  afterEach(async () => {
    vault.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  });

  it('repassa o critério completo e o orquestrador o enxerga', () => {
    const task = vault.taskFromPlaybook(vault.playbook('completo'), { titulo: 'T', repoPath });
    expect(task.criterio).toEqual({
      comandos: ['pnpm lint', 'pnpm test'],
      checklist: ['Modo escuro funciona'],
      revisao: { perfil: 'revisor', exigeAprovacao: true },
    });
    // A execução lê `task.criterio.comandos` e `.revisao` da definição validada.
    const definition = parseTaskDefinition(task);
    expect(definition.criterio?.comandos).toEqual(['pnpm lint', 'pnpm test']);
    expect(definition.criterio?.revisao?.perfil).toBe('revisor');
  });

  it('repassa um critério parcial', () => {
    const task = vault.taskFromPlaybook(vault.playbook('parcial'), { titulo: 'T', repoPath });
    expect(parseTaskDefinition(task).criterio).toEqual({ comandos: ['pnpm test'] });
  });

  it('sem critério no playbook, a tarefa fica sem critério', () => {
    const task = vault.taskFromPlaybook(vault.playbook('sem'), { titulo: 'T', repoPath });
    expect('criterio' in task).toBe(false);
    expect(parseTaskDefinition(task).criterio).toBeUndefined();
  });

  it('soma o critério da nota ao do playbook em vez de apagá-lo', async () => {
    await vault.write(
      'Projetos/ComPlaybook',
      '---\nrepo: /src/app\nplaybook: parcial\ncriterio:\n  comandos: [pnpm build]\n---\n# Com\nx',
      'substituir',
      false,
    );
    await vault.write(
      'Projetos/SemCriterio',
      '---\nrepo: /src/app\nplaybook: parcial\n---\n# Sem\nx',
      'substituir',
      false,
    );
    await vault.write(
      'Projetos/SoDaNota',
      '---\nrepo: /src/app\ncriterio:\n  comandos: [pnpm build]\n---\n# SoNota\nx',
      'substituir',
      false,
    );
    expect(vault.taskFromNote('ComPlaybook').criterio).toEqual({
      comandos: ['pnpm test', 'pnpm build'],
    });
    expect(vault.taskFromNote('SemCriterio').criterio).toEqual({ comandos: ['pnpm test'] });
    expect(vault.taskFromNote('SoDaNota').criterio).toEqual({ comandos: ['pnpm build'] });
  });
});

describe('mergeCriterio', () => {
  it('combina campo a campo sem afrouxar o playbook', () => {
    expect(
      mergeCriterio(
        {
          comandos: ['pnpm lint', 'pnpm test'],
          checklist: ['a'],
          revisao: { perfil: 'p', exigeAprovacao: true },
        },
        {
          comandos: ['pnpm test', 'pnpm build'],
          revisao: { perfil: 'n', exigeAprovacao: false },
        },
      ),
    ).toEqual({
      comandos: ['pnpm lint', 'pnpm test', 'pnpm build'],
      checklist: ['a'],
      revisao: { perfil: 'n', exigeAprovacao: true },
    });
  });

  it('usa o que existir quando um dos lados falta', () => {
    expect(mergeCriterio(undefined, undefined)).toBeUndefined();
    expect(mergeCriterio({ comandos: ['x'] }, undefined)).toEqual({ comandos: ['x'] });
    expect(mergeCriterio(undefined, { checklist: ['y'] })).toEqual({ checklist: ['y'] });
    expect(mergeCriterio({ revisao: { perfil: 'p' } }, { comandos: ['z'] })).toEqual({
      comandos: ['z'],
      revisao: { perfil: 'p' },
    });
  });

  it('deixa passar valor inválido para o orquestrador recusar', () => {
    expect(mergeCriterio({ comandos: ['x'] }, 'texto')).toBe('texto');
    expect(mergeCriterio({ comandos: ['x'] }, { comandos: 'pnpm test' })).toEqual({
      comandos: 'pnpm test',
    });
  });
});
