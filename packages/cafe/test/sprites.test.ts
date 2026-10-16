import { describe, expect, it } from 'vitest';

import { agentSprites, FOOT_X, FOOT_Y, FRAME_H, FRAME_W } from '../src/art/agents.js';
import { KEY } from '../src/art/palette.js';
import { sceneSprites } from '../src/art/scene.js';
import { uiSprites } from '../src/art/ui.js';
import { hex, Pix } from '../src/pixel.js';

const all = [...sceneSprites, ...agentSprites, ...uiSprites];

function paint(id: string): Pix {
  const def = all.find((d) => d.id === id);
  if (!def) throw new Error(id);
  const p = new Pix(def.w * def.frames, def.h * def.rows);
  def.paint(p);
  return p;
}

describe('catálogo de sprites do café', () => {
  it('tem um arquivo por sprite, sem repetir', () => {
    const files = all.map((d) => d.file);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files)
      expect(file).toMatch(/^(tiles|props|agents|screens|emotes|sky)\/[a-z0-9-]+\.png$/);
  });

  it('põe a âncora dentro do quadro', () => {
    for (const d of all) {
      expect(d.ax, d.id).toBeGreaterThanOrEqual(0);
      expect(d.ax, d.id).toBeLessThanOrEqual(d.w);
      expect(d.ay, d.id).toBeGreaterThanOrEqual(0);
      expect(d.ay, d.id).toBeLessThanOrEqual(d.h);
    }
  });

  it('usa quadros de 32x48 com o pé em (16, 46) nos agentes', () => {
    for (const d of agentSprites.filter(
      (s) => s.id.startsWith('agent-') || s.id.startsWith('npc-'),
    )) {
      expect([d.w, d.h, d.ax, d.ay], d.id).toEqual([FRAME_W, FRAME_H, FOOT_X, FOOT_Y]);
    }
  });

  it('pinta todos os provisórios sem erro e com algum pixel', () => {
    for (const d of all) {
      const p = paint(d.id);
      expect(
        p.data.some((v, i) => i % 4 === 3 && v > 0),
        d.id,
      ).toBe(true);
    }
  });

  it('pinta o agente nas cores-chave da troca de paleta', () => {
    const p = paint('agent-sit-typing');
    const colors = new Set<string>();
    for (let i = 0; i < p.data.length; i += 4) {
      if ((p.data[i + 3] ?? 0) > 0)
        colors.add(hex([p.data[i] ?? 0, p.data[i + 1] ?? 0, p.data[i + 2] ?? 0, 255]));
    }
    expect(colors).toContain(KEY.shirt);
    expect(colors).toContain(KEY.hair);
  });

  it('deixa a tela do monitor vazada com 21x15 px', () => {
    const p = paint('monitor-front');
    // Coluna 2 é a primeira da tela; a moldura começa na linha 1.
    let clear = 0;
    for (let y = 0; y < p.height; y++) if (p.get(12, y)[3] === 0) clear++;
    expect(p.get(12, 8)[3]).toBe(0);
    expect(clear).toBeGreaterThanOrEqual(15);
  });
});
