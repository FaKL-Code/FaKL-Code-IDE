import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentProfileAvailability } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { EMPTY_PROGRESS, stepViews, withStep } from '../src/setup-model.js';
import {
  pendingTips,
  pickSampleProfile,
  sampleFiles,
  sampleTask,
  tourTips,
  TOUR_STEPS,
  TOUR_WALKTHROUGH,
  withTipSeen,
  withTipsOff,
  withTipsReset,
} from '../src/tour-model.js';

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { readonly command: string }[];
    readonly walkthroughs: readonly {
      readonly id: string;
      readonly steps: readonly {
        readonly id: string;
        readonly description: string;
        readonly media: { readonly image?: string };
        readonly completionEvents: readonly string[];
      }[];
    }[];
  };
}

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
const nls = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8')) as Record<
  string,
  string
>;
/** O texto de um `%chave%` do manifesto, em inglês. */
const text = (value: string): string => nls[value.replace(/%/g, '')] ?? value;

describe('dicas', () => {
  it('cada tela tem dica e os ids são únicos', () => {
    const tips = tourTips();
    expect(new Set(tips.map((tip) => tip.id)).size).toBe(tips.length);
    expect(new Set(tips.map((tip) => tip.superficie))).toEqual(
      new Set(['mesa', 'chat', 'cafe', 'vault']),
    );
  });

  it('só manda as ainda não vistas da própria tela', () => {
    expect(pendingTips('mesa', EMPTY_PROGRESS).map((tip) => tip.id)).toEqual(['mesa.cartoes']);
    const seen = withTipSeen(EMPTY_PROGRESS, 'mesa.cartoes');
    expect(pendingTips('mesa', seen)).toEqual([]);
    expect(pendingTips('chat', seen)).toHaveLength(1);
  });

  it('dispensar duas vezes não repete o id, e id desconhecido é ignorado', () => {
    const once = withTipSeen(EMPTY_PROGRESS, 'chat.escrever');
    expect(withTipSeen(once, 'chat.escrever').dicasVistas).toEqual(['chat.escrever']);
    expect(withTipSeen(once, 'inventada')).toBe(once);
  });

  it('desligar apaga todas, e mostrar de novo traz tudo de volta sem mexer na jornada', () => {
    const base = withStep(withTipSeen(EMPTY_PROGRESS, 'mesa.cartoes'), 'feitas', 'tema');
    const off = withTipsOff(base);
    expect(pendingTips('chat', off)).toEqual([]);
    const reset = withTipsReset(off);
    expect(pendingTips('mesa', reset)).toHaveLength(1);
    expect(reset.feitas).toEqual(['tema']);
    expect(reset.dicasVistas).toBeUndefined();
    expect(reset.dicasDesligadas).toBeUndefined();
  });

  it('as dicas ficam no progresso da jornada, e passar pela jornada não as apaga', () => {
    const seen = withTipSeen(EMPTY_PROGRESS, 'cafe.agente');
    const after = withStep(seen, 'puladas', 'cli');
    expect(after.dicasVistas).toEqual(['cafe.agente']);
  });

  it('nenhum texto leva emoji', () => {
    const text = JSON.stringify([tourTips(), sampleFiles(), sampleTask()]);
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
  });
});

describe('walkthrough "fakl.tour"', () => {
  const tour = manifest.contributes.walkthroughs.find((item) => item.id === 'fakl.tour');
  const commands = new Set(manifest.contributes.commands.map((item) => item.command));

  it('o id usado para abrir é o do manifesto', () => {
    expect(TOUR_WALKTHROUGH).toBe('fakl.fakl-core#fakl.tour');
    expect(tour).toBeDefined();
  });

  it('tem os mesmos passos do modelo, na mesma ordem', () => {
    expect(tour?.steps.map((step) => step.id)).toEqual(TOUR_STEPS.map((step) => step.id));
  });

  it('cada passo abre o seu comando, que existe, e leva uma imagem', () => {
    for (const step of TOUR_STEPS) {
      const found = tour?.steps.find((candidate) => candidate.id === step.id);
      expect(found, step.id).toBeDefined();
      expect(commands.has(step.comando), step.comando).toBe(true);
      expect(found?.completionEvents).toContain(`onCommand:${step.comando}`);
      expect(text(found?.description ?? '')).toContain(`command:${step.comando}`);
      expect(found?.media.image, step.id).toMatch(/^media\/.+\.svg$/);
    }
  });

  it('os comandos novos estão no manifesto', () => {
    for (const command of ['fakl.doctor.open', 'fakl.tour.open', 'fakl.tour.resetTips']) {
      expect(commands.has(command), command).toBe(true);
    }
  });
});

describe('jornada de configuração', () => {
  it('traz o Doctor e o tour como etapas puláveis, com o botão certo', () => {
    const views = stepViews({ conectado: false, cliNoPath: false }, EMPTY_PROGRESS);
    for (const [id, command] of [
      ['doctor', 'fakl.doctor.open'],
      ['tour', 'fakl.tour.open'],
    ] as const) {
      const step = views.find((view) => view.id === id);
      expect(step?.estado).toBe('pendente');
      expect(step?.acoes[0]?.id).toBe(command);
    }
    const skipped = stepViews(
      { conectado: false, cliNoPath: false },
      withStep(EMPTY_PROGRESS, 'puladas', 'tour'),
    );
    expect(skipped.find((view) => view.id === 'tour')?.estado).toBe('pulado');
  });
});

describe('primeira tarefa', () => {
  const profile = (id: string, status: 'pronto' | 'não-instalado'): AgentProfileAvailability => ({
    id,
    nome: id,
    provedor: id,
    availability: { status },
  });

  it('usa o primeiro agente pronto; nenhum pronto, nada a rodar', () => {
    expect(
      pickSampleProfile([
        profile('a', 'não-instalado'),
        profile('b', 'pronto'),
        profile('c', 'pronto'),
      ])?.id,
    ).toBe('b');
    expect(pickSampleProfile([profile('a', 'não-instalado')])).toBeUndefined();
  });

  it('a pasta de exemplo tem arquivos e o pedido só manda ler', () => {
    expect(sampleFiles().map((file) => file.nome)).toEqual(['README.md', 'todo.txt']);
    expect(sampleTask()).toContain('Do not change any file');
  });
});
