import { describe, expect, it } from 'vitest';

import { familyOf, highlight } from '../src/highlight.js';
import { renderMarkdown } from '../src/markdown.js';

describe('highlight', () => {
  it('deixa linguagem desconhecida só escapada', () => {
    expect(highlight('a < b', 'brainfuck')).toBe('a &lt; b');
    expect(highlight('a < b', undefined)).toBe('a &lt; b');
  });

  it('marca palavra-chave, string, número e comentário', () => {
    const html = highlight('const x = "a<b"; // fim\nreturn 42;', 'ts');
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-string">&quot;a&lt;b&quot;</span>');
    expect(html).toContain('<span class="tok-comment">// fim</span>');
    expect(html).toContain('<span class="tok-number">42</span>');
  });

  it('distingue chamada de função e tipo', () => {
    const html = highlight('foo(new Map())', 'js');
    expect(html).toContain('<span class="tok-function">foo</span>');
    expect(html).toContain('<span class="tok-type">Map</span>');
  });

  it('chaves de JSON viram propriedade', () => {
    const html = highlight('{"a": true, "b": "x"}', 'json');
    expect(html).toContain('<span class="tok-property">&quot;a&quot;</span>');
    expect(html).toContain('<span class="tok-keyword">true</span>');
    expect(html).toContain('<span class="tok-string">&quot;x&quot;</span>');
  });

  it('aceita strings e comentários sem fechar (streaming)', () => {
    expect(highlight('x = "abc', 'py')).toContain('<span class="tok-string">&quot;abc</span>');
    expect(highlight('/* aberto', 'css')).toContain('<span class="tok-comment">');
  });

  it('colore diff por linha', () => {
    const html = highlight('--- a\n+++ b\n@@ -1 +1 @@\n-velho\n+novo\n igual', 'diff');
    expect(html).toContain('<span class="tok-add">+novo</span>');
    expect(html).toContain('<span class="tok-del">-velho</span>');
    expect(html).toContain('<span class="tok-meta">@@ -1 +1 @@</span>');
  });

  it('nunca deixa HTML do código passar', () => {
    const html = highlight('<script>alert("x")</script>', 'html');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script');
  });

  it('familyOf ignora caixa', () => {
    expect(familyOf('TypeScript')).toBe('c');
    expect(familyOf('nada')).toBeUndefined();
  });
});

describe('renderMarkdown com realce', () => {
  it('só realça quando pedido', () => {
    const source = '```ts\nconst a = 1;\n```';
    expect(renderMarkdown(source)).toBe('<pre data-lang="ts"><code>const a = 1;</code></pre>');
    expect(renderMarkdown(source, { highlight: true })).toContain('tok-keyword');
  });
});
