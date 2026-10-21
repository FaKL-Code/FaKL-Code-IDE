import { describe, expect, it } from 'vitest';

import {
  ajudaDaIde,
  guiaCompleto,
  guiaIndice,
  pesoDasFerramentas,
  promptDeConversa,
  TEMAS_DO_GUIA,
  TOOL_SETS,
} from '../src/index.js';

describe('guia da IDE', () => {
  it('o índice do prompt é curto e lista todos os temas', () => {
    const indice = guiaIndice();
    for (const tema of TEMAS_DO_GUIA) expect(indice).toContain(tema.id);
    expect(indice).toContain('ajuda_ide');
    // Vai em toda requisição: tem que ficar pequeno (menos de ~150 tokens).
    expect(indice.length).toBeLessThan(600);
  });

  it('ensina a limpar a Mesa', () => {
    const texto = ajudaDaIde('mesa');
    expect(texto).toContain('Limpar encerrados');
    expect(ajudaDaIde(' MESA ')).toBe(texto);
  });

  it('sem tema, ou com tema desconhecido, lista os temas', () => {
    for (const pedido of [undefined, '', 'nada a ver', 42]) {
      const texto = ajudaDaIde(pedido);
      for (const tema of TEMAS_DO_GUIA) expect(texto).toContain(`- ${tema.id}:`);
    }
  });

  it('o modo conversa leva o guia inteiro e manda não usar ferramentas', () => {
    const prompt = promptDeConversa();
    expect(prompt).toContain('conversa simples');
    expect(prompt).toContain(guiaCompleto());
    expect(prompt).not.toContain('ajuda_ide');
  });

  it('a ferramenta ajuda_ide faz parte dos conjuntos de ferramentas', () => {
    expect(TOOL_SETS.ide.map((tool) => tool.method)).toEqual(['guia.tema']);
  });

  it('estima o peso das definições de ferramentas', () => {
    const peso = pesoDasFerramentas(TOOL_SETS.vault);
    expect(peso.ferramentas).toBe(TOOL_SETS.vault.length);
    expect(peso.tokens).toBeGreaterThan(100);
    expect(pesoDasFerramentas([])).toEqual({ ferramentas: 0, tokens: 0 });
  });
});
