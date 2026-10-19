import { describe, expect, it } from 'vitest';

import { agentSprites, FOOT_X, FOOT_Y, FRAME_H, FRAME_W } from '../src/art/agents.js';
import { COOK_FOOT_X, COOK_FOOT_Y, COOK_H, COOK_W, kitchenSprites } from '../src/art/cozinha.js';
import { KEY } from '../src/art/palette.js';
import { sceneSprites } from '../src/art/scene.js';
import { uiSprites } from '../src/art/ui.js';
import { hex, Pix } from '../src/pixel.js';

const all = [...sceneSprites, ...agentSprites, ...uiSprites, ...kitchenSprites];

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

  it('desenha a cozinha do CI com os quadros de cada estado', () => {
    const byId = (id: string) => {
      const def = kitchenSprites.find((d) => d.id === id);
      if (!def) throw new Error(id);
      return def;
    };
    const cook = byId('kitchen-cook');
    expect([cook.w, cook.h, cook.ax, cook.ay]).toEqual([COOK_W, COOK_H, COOK_FOOT_X, COOK_FOOT_Y]);
    // Parado, dois de trabalho, comemorando e assustado.
    expect(cook.frames).toBe(5);
    // Uma xícara por estado de job: fila, enchendo, servida, rachada, virada e com senha.
    expect(byId('kitchen-cup').frames).toBe(6);
    expect(byId('kitchen-bell').frames).toBe(2);
    expect(byId('kitchen-alarm').frames).toBe(2);
    expect(byId('kitchen-smoke').frames).toBe(4);
    expect(byId('kitchen-ticket').frames).toBe(2);
  });

  it('pinta cada quadro da cozinha com algum pixel e quadros diferentes entre si', () => {
    for (const d of kitchenSprites) {
      const p = paint(d.id);
      for (let f = 0; f < d.frames; f++) {
        // `get` é relativo ao quadro posicionado por último.
        p.frame(f, 0, d.w, d.h);
        let lit = 0;
        for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) if (p.get(x, y)[3] > 0) lit++;
        expect(lit, `${d.id} quadro ${String(f)}`).toBeGreaterThan(0);
      }
    }
    const sheet = (id: string, frame: number): string => {
      const d = kitchenSprites.find((s) => s.id === id);
      if (!d) throw new Error(id);
      const p = paint(id);
      p.frame(frame, 0, d.w, d.h);
      const cells: string[] = [];
      for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) cells.push(hex(p.get(x, y)));
      return cells.join('');
    };
    // Os quadros que carregam o estado não podem ser iguais.
    const poses = new Set([0, 1, 2, 3, 4].map((f) => sheet('kitchen-cook', f)));
    expect(poses.size).toBe(5);
    const cups = new Set([0, 1, 2, 3, 4, 5].map((f) => sheet('kitchen-cup', f)));
    expect(cups.size).toBe(6);
  });

  it('deixa o café da xícara servida e a rachadura da falha com cores diferentes', () => {
    const p = paint('kitchen-cup');
    const colors = (frame: number): Set<string> => {
      p.frame(frame, 0, 10, 12);
      const set = new Set<string>();
      for (let y = 0; y < 12; y++)
        for (let x = 0; x < 10; x++) {
          const px = p.get(x, y);
          if (px[3] > 0) set.add(hex(px));
        }
      return set;
    };
    expect(colors(2)).toContain('#3fbf6f');
    expect(colors(3)).toContain('#e05d5d');
  });
});
