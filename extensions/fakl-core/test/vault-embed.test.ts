import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';

import {
  EMBED_MAX_DEPTH,
  extractSection,
  resolveEmbed,
  stripFrontmatter,
  truncateEmbed,
  type EmbedNote,
} from '../src/vault-embed.js';
import { vaultMarkdown } from '../src/vault-markdown.js';

function vault(notes: Record<string, string>): (target: string) => EmbedNote | undefined {
  return (target) => {
    const key = target.toLowerCase();
    const text = notes[key];
    return text === undefined ? undefined : { key, text };
  };
}

const fresh = (): { left: number } => ({ left: 100_000 });

describe('stripFrontmatter e extractSection', () => {
  it('tira o frontmatter e deixa o resto', () => {
    expect(stripFrontmatter('---\ntipo: x\n---\n# A\ntexto')).toBe('# A\ntexto');
    expect(stripFrontmatter('sem frontmatter')).toBe('sem frontmatter');
  });

  const text = [
    '# Nota',
    'abertura',
    '## Decisão',
    'usar git',
    '### Detalhe',
    'por causa do merge',
    '## Outra',
    'fim',
  ].join('\n');

  it('devolve a seção inteira, com as subseções, até o próximo título do mesmo nível', () => {
    expect(extractSection(text, 'Decisão')).toBe(
      '## Decisão\nusar git\n### Detalhe\npor causa do merge',
    );
    expect(extractSection(text, 'detalhe')).toBe('### Detalhe\npor causa do merge');
    expect(extractSection(text, 'Outra')).toBe('## Outra\nfim');
  });

  it('não acha título que não existe nem título dentro de código', () => {
    expect(extractSection(text, 'Inexistente')).toBeUndefined();
    expect(extractSection('```\n## Falso\n```\n', 'Falso')).toBeUndefined();
  });
});

describe('truncateEmbed', () => {
  it('não mexe no que cabe e marca o corte no que não cabe', () => {
    expect(truncateEmbed('curto', 10)).toBe('curto');
    expect(truncateEmbed('linha um\nlinha dois\nlinha três', 20)).toBe('linha um\nlinha dois\n\n…');
  });
});

describe('resolveEmbed', () => {
  const read = vault({
    a: '---\nx: 1\n---\n# A\ncorpo de A',
    b: 'corpo de B',
    c: 'corpo de C',
    secoes: '# T\n## Um\nprimeiro\n## Dois\nsegundo',
    grande: 'x'.repeat(50),
  });

  it('incorpora a nota sem o frontmatter', () => {
    expect(resolveEmbed('a', undefined, read, [], fresh())).toEqual({
      kind: 'ok',
      key: 'a',
      markdown: '# A\ncorpo de A',
    });
  });

  it('incorpora só a seção de `#Título`', () => {
    expect(resolveEmbed('secoes', 'Dois', read, [], fresh())).toMatchObject({
      kind: 'ok',
      markdown: '## Dois\nsegundo',
    });
    expect(resolveEmbed('secoes', 'Nenhum', read, [], fresh())).toEqual({
      kind: 'link',
      reason: 'section',
    });
  });

  it('cai no link quando a nota não existe', () => {
    expect(resolveEmbed('fantasma', undefined, read, [], fresh())).toEqual({
      kind: 'link',
      reason: 'missing',
    });
  });

  it('detecta ciclo: nota em andamento e a nota aberta', () => {
    expect(resolveEmbed('a', undefined, read, ['a'], fresh())).toMatchObject({ reason: 'cycle' });
    expect(resolveEmbed('a', undefined, read, [], fresh(), { rootKey: 'a' })).toMatchObject({
      reason: 'cycle',
    });
  });

  it('respeita a profundidade máxima de 2 níveis', () => {
    expect(EMBED_MAX_DEPTH).toBe(2);
    expect(resolveEmbed('c', undefined, read, [], fresh()).kind).toBe('ok');
    expect(resolveEmbed('c', undefined, read, ['a'], fresh()).kind).toBe('ok');
    expect(resolveEmbed('c', undefined, read, ['a', 'b'], fresh())).toEqual({
      kind: 'link',
      reason: 'depth',
    });
  });

  it('corta pelo limite de tamanho e esgota o orçamento da prévia', () => {
    expect(resolveEmbed('grande', undefined, read, [], fresh(), { maxChars: 10 })).toEqual({
      kind: 'ok',
      key: 'grande',
      markdown: `${'x'.repeat(10)}\n\n…`,
    });
    const budget = { left: 30 };
    expect(resolveEmbed('grande', undefined, read, [], budget).kind).toBe('ok');
    expect(budget.left).toBeLessThanOrEqual(0);
    expect(resolveEmbed('b', undefined, read, [], budget)).toEqual({
      kind: 'link',
      reason: 'budget',
    });
  });
});

describe('prévia com embed de nota', () => {
  const notes: Record<string, string> = {
    decisões: '---\ntipo: nota\n---\n# Decisões\nUsar git.\n\n## Sync\nA cada 2 min.\n',
    ciclo: 'Início\n\n![[ciclo]]\n',
    ida: 'Ida\n\n![[volta]]\n',
    volta: 'Volta\n\n![[ida]]\n',
    n1: 'nível 1\n\n![[n2]]\n',
    n2: 'nível 2\n\n![[n3]]\n',
    n3: 'nível 3\n\n![[n4]]\n',
    n4: 'nível 4',
  };
  const hrefs: Record<string, string> = {
    ...Object.fromEntries(Object.keys(notes).map((k) => [k, `../${k}.md`])),
    'diagrama.png': '../Anexos/diagrama.png',
  };
  const build = (): MarkdownIt =>
    vaultMarkdown(new MarkdownIt({ html: true }), (target) => hrefs[target.toLowerCase()], {
      read: vault(notes),
      currentKey: () => 'aberta',
    });

  it('incorpora o conteúdo da nota, sem o frontmatter', () => {
    const html = build().render('Antes\n\n![[Decisões]]\n\nDepois');
    expect(html).toContain('<div class="fakl-embed" data-embed="decisões">');
    expect(html).toContain('<h1>Decisões</h1>');
    expect(html).toContain('A cada 2 min.');
    expect(html).not.toContain('tipo: nota');
    expect(html).toContain('<p>Antes</p>');
    expect(html).toContain('<p>Depois</p>');
  });

  it('`![[nota#Título]]` incorpora só a seção', () => {
    const html = build().render('![[Decisões#Sync]]');
    expect(html).toContain('<h2>Sync</h2>');
    expect(html).toContain('A cada 2 min.');
    expect(html).not.toContain('Usar git.');
  });

  it('nota ausente, seção ausente e embed no meio do texto viram link', () => {
    const md = build();
    expect(md.render('![[Fantasma]]')).toContain('fakl-wikilink fakl-wikilink-missing');
    expect(md.render('![[Decisões#Nada]]')).toContain('<a href="../decis');
    expect(md.render('![[Decisões#Nada]]')).not.toContain('fakl-embed');
    expect(md.render('veja ![[Decisões]] aqui')).not.toContain('fakl-embed');
  });

  it('imagens e anexos continuam como antes', () => {
    const md = build();
    expect(md.renderInline('![[diagrama.png|Fluxo]]')).toBe(
      '<img src="../Anexos/diagrama.png" alt="Fluxo">',
    );
    expect(md.render('![[diagrama.png]]')).not.toContain('fakl-embed');
  });

  it('não entra em loop: nota que se embute e notas que se embutem uma na outra', () => {
    const md = build();
    const self = md.render('![[ciclo]]');
    expect(self.match(/fakl-embed"/g)).toHaveLength(1);
    expect(self).toContain('fakl-wikilink');
    const pair = md.render('![[ida]]');
    expect(pair.match(/fakl-embed"/g)).toHaveLength(2);
  });

  it('segue no máximo 2 níveis de embed dentro de embed', () => {
    const html = build().render('![[n1]]');
    expect(html).toContain('nível 1');
    expect(html).toContain('nível 2');
    expect(html).not.toContain('nível 3');
    expect(html).toContain('<a href="../n3.md"');
  });

  it('sem fonte de notas, o embed é só link, como antes', () => {
    const md = vaultMarkdown(new MarkdownIt(), (target) => hrefs[target.toLowerCase()]);
    expect(md.render('![[Decisões]]')).not.toContain('fakl-embed');
  });
});
