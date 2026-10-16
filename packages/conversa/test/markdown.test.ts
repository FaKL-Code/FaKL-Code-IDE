import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../src/markdown.js';

describe('renderMarkdown', () => {
  it('escapa HTML do agente', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    );
  });

  it('formata código, negrito, listas e links', () => {
    expect(renderMarkdown('Use **pnpm** e `a*b*c`:\n\n- um\n- [doc](https://x.dev)')).toBe(
      '<p>Use <strong>pnpm</strong> e <code>a*b*c</code>:</p><ul><li>um</li><li><a href="https://x.dev">doc</a></li></ul>',
    );
  });

  it('mantém blocos de código como estão', () => {
    expect(renderMarkdown('```ts\nconst a = 1 < 2;\n**não**\n```')).toBe(
      '<pre data-lang="ts"><code>const a = 1 &lt; 2;\n**não**</code></pre>',
    );
  });

  it('não vira link quando o endereço não é http', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>');
  });
});
