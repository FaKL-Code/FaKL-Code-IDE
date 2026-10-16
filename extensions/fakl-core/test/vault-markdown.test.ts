import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';

import { headingSlug, vaultMarkdown } from '../src/vault-markdown.js';

const notes: Record<string, string> = {
  decisões: '../Decis%C3%B5es.md',
  'diagrama.png': '../Anexos/diagrama.png',
};

const md = vaultMarkdown(new MarkdownIt({ html: true }), (target) => notes[target.toLowerCase()]);

describe('prévia do vault', () => {
  it('troca wikilinks por links para a nota', () => {
    expect(md.renderInline('Veja [[Decisões]] e [[Decisões|isto]].')).toBe(
      'Veja <a href="../Decis%C3%B5es.md" class="fakl-wikilink">Decisões</a> e ' +
        '<a href="../Decis%C3%B5es.md" class="fakl-wikilink">isto</a>.',
    );
  });

  it('aponta para o título e marca nota que não existe', () => {
    expect(md.renderInline('[[Decisões#Vault no Core]]')).toBe(
      `<a href="../Decis%C3%B5es.md#${headingSlug('Vault no Core')}" class="fakl-wikilink">Decisões › Vault no Core</a>`,
    );
    expect(md.renderInline('[[Nova ideia]]')).toBe(
      `<a href="Nova%20ideia.md" class="fakl-wikilink fakl-wikilink-missing" title="Note doesn't exist yet">Nova ideia</a>`,
    );
  });

  it('mostra imagens embutidas', () => {
    expect(md.renderInline('![[diagrama.png|Fluxo]]')).toBe(
      '<img src="../Anexos/diagrama.png" alt="Fluxo">',
    );
  });

  it('não mexe em código', () => {
    expect(md.renderInline('`[[Decisões]]`')).toBe('<code>[[Decisões]]</code>');
  });

  it('desenha callouts', () => {
    expect(md.render('> [!warning] Cuidado\n> Texto do aviso.')).toBe(
      '<blockquote class="fakl-callout fakl-callout-warning" data-callout="warning">\n' +
        '<p class="fakl-callout-title">Cuidado</p>\n<p>Texto do aviso.</p>\n</blockquote>\n',
    );
    expect(md.render('> [!tip]')).toBe(
      '<blockquote class="fakl-callout fakl-callout-tip" data-callout="tip">\n' +
        '<p class="fakl-callout-title">Tip</p>\n</blockquote>\n',
    );
    expect(md.render('> citação comum')).toBe(
      '<blockquote>\n<p>citação comum</p>\n</blockquote>\n',
    );
  });

  it('gera âncoras como a prévia', () => {
    expect(headingSlug('Vault no Core')).toBe('vault-no-core');
  });
});
