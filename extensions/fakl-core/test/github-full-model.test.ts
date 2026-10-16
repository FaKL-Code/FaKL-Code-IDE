import type { GhComment, GhNotification, GhReview } from '@fakl/integrations';
import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import {
  blogUrl,
  breadcrumbs,
  filterRepos,
  formatBytes,
  formatCount,
  formatDuration,
  githubUrl,
  popularRepos,
  profileView,
  repoLanguages,
  routeTitle,
  sameUserTab,
  SessionCache,
  StaleSessionError,
  userRoute,
  joinRepoPath,
  labelInk,
  languageShares,
  notificationGroups,
  parseFromWebview,
  parseGitHubUrl,
  parseRoute,
  pullState,
  relativeTime,
  resolveImage,
  resolveLink,
  RouteHistory,
  normalizeHref,
  routeKey,
  splitRefPath,
  runState,
  timeline,
  USER_TAB_LABELS,
  userTabLabel,
  type DocContext,
} from '../src/github-full-model.js';
import type { RepoRow, Route } from '../src/github-full-protocol.js';

const ctx: DocContext = { owner: 'octo', name: 'hello', ref: 'main', dir: 'docs' };

describe('parseGitHubUrl', () => {
  it.each<[string, Route | undefined]>([
    ['https://github.com/octo', { view: 'user', login: 'octo' }],
    ['https://github.com/orgs/fakl', { view: 'user', login: 'fakl' }],
    ['https://github.com/octo/hello', { view: 'repo', owner: 'octo', name: 'hello', tab: 'code' }],
    [
      'https://github.com/octo/hello/tree/dev/src/lib',
      { view: 'repo', owner: 'octo', name: 'hello', tab: 'code', ref: 'dev', path: 'src/lib' },
    ],
    [
      'https://github.com/octo/hello/blob/main/docs/a%20b.md',
      { view: 'file', owner: 'octo', name: 'hello', ref: 'main', path: 'docs/a b.md' },
    ],
    [
      'https://github.com/octo/hello/pull/7/files',
      { view: 'pull', owner: 'octo', name: 'hello', number: 7, tab: 'files' },
    ],
    [
      'https://github.com/octo/hello/issues/3',
      { view: 'issue', owner: 'octo', name: 'hello', number: 3 },
    ],
    [
      'https://github.com/octo/hello/actions/runs/99',
      { view: 'run', owner: 'octo', name: 'hello', id: 99 },
    ],
    [
      'https://api.github.com/repos/octo/hello/pulls/5',
      { view: 'pull', owner: 'octo', name: 'hello', number: 5, tab: 'conversation' },
    ],
    ['https://github.com/notifications', { view: 'notifications' }],
    ['https://github.com/settings/tokens', undefined],
    ['https://github.com/octo/hello/wiki', undefined],
    ['https://gitlab.com/octo/hello', undefined],
    ['javascript:alert(1)', undefined],
  ])('%s', (url, route) => {
    expect(parseGitHubUrl(url)).toEqual(route);
  });

  it('faz o caminho de volta com githubUrl', () => {
    for (const url of [
      'https://github.com/octo/hello/pull/7/files',
      'https://github.com/octo/hello/issues/3',
      'https://github.com/octo/hello/blob/main/docs/a.md',
      'https://github.com/octo/hello/actions/runs/99',
    ]) {
      const route = parseGitHubUrl(url);
      expect(route && githubUrl(route)).toBe(url);
    }
  });
});

describe('perfil', () => {
  const row = (name: string, extra: Partial<RepoRow> = {}): RepoRow => ({
    owner: 'octo',
    name,
    private: false,
    fork: false,
    archived: false,
    stars: 0,
    forks: 0,
    ...extra,
  });
  const rows: RepoRow[] = [
    row('zeta', { language: 'Go', stars: 5, updatedAt: '2026-01-03T00:00:00Z' }),
    row('Alpha', {
      language: 'TypeScript',
      private: true,
      description: 'painel de deploy',
      updatedAt: '2026-01-05T00:00:00Z',
    }),
    row('beta-fork', { fork: true, language: 'Go', stars: 9, updatedAt: '2026-01-01T00:00:00Z' }),
    row('velho', { archived: true, stars: 5, updatedAt: '2026-01-04T00:00:00Z' }),
  ];
  const names = (list: readonly RepoRow[]): string[] => list.map((r) => r.name);

  it.each<[string, Route]>([
    [
      'https://github.com/octo?tab=repositories',
      { view: 'user', login: 'octo', tab: 'repositories' },
    ],
    ['https://github.com/octo?tab=stars', { view: 'user', login: 'octo', tab: 'stars' }],
    ['https://github.com/octo?tab=followers', { view: 'user', login: 'octo', tab: 'followers' }],
    ['https://github.com/octo?tab=overview', { view: 'user', login: 'octo' }],
    ['https://github.com/octo?tab=projects', { view: 'user', login: 'octo' }],
    [
      'https://github.com/octo?tab=repositories&q=api&type=source&language=go&sort=stargazers',
      {
        view: 'user',
        login: 'octo',
        tab: 'repositories',
        q: 'api',
        type: 'sources',
        language: 'go',
        sort: 'stars',
      },
    ],
    [
      'https://github.com/orgs/fakl/repositories?type=archived&sort=name',
      { view: 'user', login: 'fakl', tab: 'repositories', type: 'archived', sort: 'name' },
    ],
    ['https://github.com/orgs/fakl/people', { view: 'user', login: 'fakl', tab: 'people' }],
    // Valores desconhecidos caem no padrão.
    [
      'https://github.com/octo?tab=repositories&type=mirror&sort=size&q=',
      { view: 'user', login: 'octo', tab: 'repositories' },
    ],
  ])('lê %s', (url, route) => {
    expect(parseGitHubUrl(url)).toEqual(route);
  });

  it('ignora type e sort que são nomes do protótipo de Object', () => {
    for (const value of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(
        parseGitHubUrl(`https://github.com/octo?tab=repositories&type=${value}&sort=${value}`),
      ).toEqual({ view: 'user', login: 'octo', tab: 'repositories' });
      expect(
        parseGitHubUrl(`https://github.com/orgs/acme/repositories?type=${value}&sort=${value}`),
      ).toEqual({ view: 'user', login: 'acme', tab: 'repositories' });
    }
  });

  it('faz o caminho de volta com githubUrl', () => {
    for (const url of [
      'https://github.com/octo',
      'https://github.com/octo?tab=stars',
      'https://github.com/octo?tab=repositories&q=api&type=fork&language=go&sort=name',
      'https://github.com/orgs/fakl/people',
    ]) {
      const route = parseGitHubUrl(url);
      expect(route && githubUrl(route)).toBe(url);
    }
  });

  it('userRoute tira os padrões e só guarda filtros na aba Repositórios', () => {
    expect(userRoute('octo', 'overview', { q: 'x' })).toEqual({ view: 'user', login: 'octo' });
    expect(userRoute('octo', 'stars', { q: 'x' })).toEqual({
      view: 'user',
      login: 'octo',
      tab: 'stars',
    });
    expect(
      userRoute('octo', 'repositories', { q: '  ', type: 'all', sort: 'updated', language: '' }),
    ).toEqual({ view: 'user', login: 'octo', tab: 'repositories' });
  });

  it('rotas iguais têm a mesma chave; filtros diferentes não', () => {
    const base: Route = { view: 'user', login: 'Octo', tab: 'repositories' };
    expect(routeKey(base)).toBe(routeKey({ ...base, login: 'octo', type: 'all', sort: 'updated' }));
    expect(routeKey({ ...base, language: 'Go' })).toBe(routeKey({ ...base, language: 'go' }));
    expect(routeKey(base)).not.toBe(routeKey({ ...base, q: 'api' }));
    expect(routeKey({ view: 'user', login: 'octo' })).not.toBe(routeKey(base));
    expect(sameUserTab(base, { ...base, q: 'api' })).toBe(true);
    expect(sameUserTab(base, { view: 'user', login: 'octo', tab: 'stars' })).toBe(false);
  });

  it('valida a rota de perfil vinda da webview', () => {
    expect(
      parseRoute({
        view: 'user',
        login: 'octo',
        tab: 'repositories',
        q: ' api ',
        type: 'forks',
        language: 'Go',
        sort: 'stars',
      }),
    ).toEqual({
      view: 'user',
      login: 'octo',
      tab: 'repositories',
      q: 'api',
      type: 'forks',
      language: 'Go',
      sort: 'stars',
    });
    expect(parseRoute({ view: 'user', login: 'octo', tab: 'overview' })).toEqual({
      view: 'user',
      login: 'octo',
    });
    for (const bad of [
      { tab: 'admin' },
      { tab: 'repositories', type: 'mirror' },
      { tab: 'repositories', sort: 'size' },
      { tab: 'repositories', q: 'x'.repeat(101) },
      { tab: 'repositories', q: 'a\u0000b' },
      { tab: 'repositories', language: 7 },
    ]) {
      expect(parseRoute({ view: 'user', login: 'octo', ...bad })).toBeUndefined();
    }
    expect(
      parseFromWebview({
        type: 'navigate',
        route: { view: 'user', login: 'octo', tab: 'repositories', q: 'a' },
        replace: true,
      }),
    ).toEqual({
      type: 'navigate',
      route: { view: 'user', login: 'octo', tab: 'repositories', q: 'a' },
      replace: true,
    });
    expect(parseFromWebview({ type: 'navigate', route: { view: 'home' }, replace: 'sim' })).toEqual(
      { type: 'navigate', route: { view: 'home' } },
    );
  });

  it('filtra por tipo, linguagem e busca, e ordena', () => {
    expect(names(filterRepos(rows, {}))).toEqual(['Alpha', 'velho', 'zeta', 'beta-fork']);
    expect(names(filterRepos(rows, { sort: 'name' }))).toEqual([
      'Alpha',
      'beta-fork',
      'velho',
      'zeta',
    ]);
    // Empate em estrelas: o mais recente primeiro.
    expect(names(filterRepos(rows, { sort: 'stars' }))).toEqual([
      'beta-fork',
      'velho',
      'zeta',
      'Alpha',
    ]);
    expect(names(filterRepos(rows, { type: 'public' }))).toEqual(['velho', 'zeta', 'beta-fork']);
    expect(names(filterRepos(rows, { type: 'private' }))).toEqual(['Alpha']);
    expect(names(filterRepos(rows, { type: 'sources' }))).toEqual(['Alpha', 'velho', 'zeta']);
    expect(names(filterRepos(rows, { type: 'forks' }))).toEqual(['beta-fork']);
    expect(names(filterRepos(rows, { type: 'archived' }))).toEqual(['velho']);
    expect(names(filterRepos(rows, { language: 'go' }))).toEqual(['zeta', 'beta-fork']);
    expect(names(filterRepos(rows, { q: 'DEPLOY' }))).toEqual(['Alpha']);
    expect(names(filterRepos(rows, { q: 'a', type: 'sources', language: 'Go' }))).toEqual(['zeta']);
    expect(rows.map((r) => r.name)).toEqual(['zeta', 'Alpha', 'beta-fork', 'velho']);
  });

  it('lista as linguagens e escolhe os populares', () => {
    expect(repoLanguages(rows)).toEqual(['Go', 'TypeScript']);
    expect(names(popularRepos(rows, 2))).toEqual(['zeta', 'Alpha']);
  });

  it('monta o perfil e o blog seguro', () => {
    const view = profileView(
      {
        login: 'octo',
        id: 1,
        type: 'User',
        html_url: 'https://github.com/octo',
        name: null,
        bio: 'Oi',
        followers: 3,
        following: 0,
        public_repos: 8,
      },
      true,
    );
    expect(view).toEqual({
      login: 'octo',
      kind: 'User',
      url: 'https://github.com/octo',
      mine: true,
      bio: 'Oi',
      followers: 3,
      following: 0,
      publicRepos: 8,
    });
    expect(blogUrl('octo.dev')).toBe('https://octo.dev/');
    expect(blogUrl('http://octo.dev/blog')).toBe('https://octo.dev/blog');
    // Sem esquema vira https; um esquema disfarçado não vira URL válida.
    expect(blogUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('título e caminho das abas do perfil', () => {
    expect(routeTitle({ view: 'user', login: 'octo', tab: 'stars' })).toBe('octo: stars');
    expect(breadcrumbs({ view: 'user', login: 'octo', tab: 'repositories' })).toEqual([
      { label: 'octo', route: { view: 'user', login: 'octo' } },
      { label: 'Repositories' },
    ]);
  });
});

describe('SessionCache', () => {
  it('guarda por chave até expirar', async () => {
    let now = 0;
    const cache = new SessionCache<string>(1000, () => now);
    let reads = 0;
    const read = (): Promise<string> => Promise.resolve(`leitura ${String(++reads)}`);
    expect(await cache.load('a', read)).toBe('leitura 1');
    expect(await cache.load('a', read)).toBe('leitura 1');
    expect(cache.peek('b')).toBeUndefined();
    now = 1000;
    expect(cache.peek('a')).toBeUndefined();
    expect(await cache.load('a', read)).toBe('leitura 2');
  });

  it('descarta a leitura que terminou depois da troca de sessão', async () => {
    const cache = new SessionCache<string>(60_000);
    let finish: (value: string) => void = () => undefined;
    const pending = cache.load(
      'mine:octo',
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    // Troca de conta enquanto a conta antiga ainda lia os privados.
    cache.invalidate();
    finish('privados da conta A');
    await expect(pending).rejects.toBeInstanceOf(StaleSessionError);
    expect(cache.peek('mine:octo')).toBeUndefined();
    expect(await cache.load('mine:octo', () => Promise.resolve('conta B'))).toBe('conta B');
  });

  it('invalidate apaga o que já estava guardado', async () => {
    const cache = new SessionCache<string>(60_000);
    await cache.load('a', () => Promise.resolve('x'));
    cache.invalidate();
    expect(cache.peek('a')).toBeUndefined();
  });
});

describe('links do Markdown', () => {
  it('resolve links relativos para telas do painel', () => {
    expect(resolveLink('../CONTRIBUTING.md#setup', ctx)).toEqual({
      kind: 'route',
      route: { view: 'file', owner: 'octo', name: 'hello', ref: 'main', path: 'CONTRIBUTING.md' },
      hash: 'setup',
    });
    expect(resolveLink('/src/', ctx)).toEqual({
      kind: 'route',
      route: { view: 'repo', owner: 'octo', name: 'hello', tab: 'code', ref: 'main', path: 'src' },
    });
    expect(resolveLink('./guia.md?plain=1', ctx)).toMatchObject({
      route: { view: 'file', path: 'docs/guia.md' },
    });
  });

  it('leva links do github.com para dentro e o resto para o navegador', () => {
    expect(resolveLink('https://github.com/octo/hello/issues/1', ctx)).toMatchObject({
      kind: 'route',
      route: { view: 'issue', number: 1 },
    });
    expect(resolveLink('https://exemplo.com/a', ctx)).toEqual({
      kind: 'external',
      url: 'https://exemplo.com/a',
    });
    expect(resolveLink('#instalacao', ctx)).toEqual({ kind: 'anchor', id: 'instalacao' });
  });

  it('descarta esquemas perigosos', () => {
    expect(resolveLink('javascript:alert(1)', ctx)).toBeUndefined();
    expect(resolveLink('data:text/html,<script>', ctx)).toBeUndefined();
    expect(resolveLink('file:///etc/passwd', ctx)).toBeUndefined();
    expect(resolveLink('vscode://x', ctx)).toBeUndefined();
  });

  it('resolve imagens para raw.githubusercontent e só aceita https e data:image', () => {
    expect(resolveImage('img/logo.png', ctx)).toBe(
      'https://raw.githubusercontent.com/octo/hello/main/docs/img/logo.png',
    );
    expect(resolveImage('/assets/a b.svg', ctx)).toBe(
      'https://raw.githubusercontent.com/octo/hello/main/assets/a%20b.svg',
    );
    expect(resolveImage('https://github.com/octo/hello/blob/dev/x.png?raw=true', ctx)).toBe(
      'https://raw.githubusercontent.com/octo/hello/dev/x.png',
    );
    expect(resolveImage('http://img.shields.io/badge/x.svg', ctx)).toBe(
      'https://img.shields.io/badge/x.svg',
    );
    expect(resolveImage('data:image/png;base64,AAAA', ctx)).toBe('data:image/png;base64,AAAA');
    expect(resolveImage('data:text/html;base64,AAAA', ctx)).toBeUndefined();
    expect(resolveImage('javascript:alert(1)', ctx)).toBeUndefined();
  });

  it('junta caminhos sem sair da raiz', () => {
    expect(joinRepoPath('a/b', '../../../c')).toBe('c');
    expect(joinRepoPath('a', './b/./c')).toBe('a/b/c');
    expect(joinRepoPath('a', '/x/y')).toBe('x/y');
  });
});

describe('esquemas disfarçados', () => {
  // Como o atributo chega depois do parser de HTML: `&#x09;` já virou tab.
  it.each([
    'jav\tascript:alert(1)',
    'jav\nascript:alert(1)',
    'java\rscript:alert(1)',
    '\u0000javascript:alert(1)',
    ' \t javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\u0000script:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'jav\tascript&colon;alert(1)'.replace('&colon;', ':'),
  ])('link %j é recusado', (href) => {
    expect(resolveLink(href, ctx)).toBeUndefined();
  });

  it.each([
    'jav\tascript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html;base64,AAAA',
    '\u0001file:///etc/passwd',
  ])('imagem %j é recusada', (src) => {
    expect(resolveImage(src, ctx)).toBeUndefined();
  });

  it('devolve só o destino normalizado', () => {
    expect(resolveLink('ht\ttps://exemplo.com/a b', ctx)).toEqual({
      kind: 'external',
      url: 'https://exemplo.com/a%20b',
    });
    expect(resolveImage(' https://img.dev/x.png\n', ctx)).toBe('https://img.dev/x.png');
    expect(normalizeHref(' \tja\u0085va\nscript: ')).toBe('javascript:');
  });

  it('a extensão só abre http(s) e mailto, normalizados', () => {
    expect(parseFromWebview({ type: 'external', url: 'jav\tascript:alert(1)' })).toBeUndefined();
    expect(parseFromWebview({ type: 'external', url: 'file:///c:/x' })).toBeUndefined();
    expect(parseFromWebview({ type: 'external', url: 'mailto:a@b.dev' })).toEqual({
      type: 'external',
      url: 'mailto:a@b.dev',
    });
  });
});

describe('ref com barra', () => {
  const refs = ['main', 'feature/auth', 'v1.0', 'release/2026/10'];

  it('acha o prefixo mais longo que é branch ou tag', () => {
    expect(splitRefPath('feature', 'auth/src/a.ts', refs)).toEqual({
      ref: 'feature/auth',
      path: 'src/a.ts',
    });
    expect(splitRefPath('release', '2026/10/docs', refs)).toEqual({
      ref: 'release/2026/10',
      path: 'docs',
    });
    expect(splitRefPath('feature', 'auth', refs)).toEqual({ ref: 'feature/auth', path: '' });
  });

  it('mantém ref conhecida, SHA e ref desconhecida como vieram', () => {
    expect(splitRefPath('main', 'feature/auth/x', refs)).toEqual({
      ref: 'main',
      path: 'feature/auth/x',
    });
    expect(splitRefPath('a1b2c3d', 'src/a.ts', refs)).toEqual({ ref: 'a1b2c3d', path: 'src/a.ts' });
    expect(splitRefPath('x', 'y/z', refs)).toEqual({ ref: 'x', path: 'y/z' });
  });

  it('as URLs geradas preservam a ref inteira', () => {
    expect(
      githubUrl({ view: 'file', owner: 'o', name: 'r', ref: 'feature/auth', path: 'src/a.ts' }),
    ).toBe('https://github.com/o/r/blob/feature/auth/src/a.ts');
    expect(
      githubUrl({
        view: 'repo',
        owner: 'o',
        name: 'r',
        tab: 'code',
        ref: 'feature/auth',
        path: 'src',
      }),
    ).toBe('https://github.com/o/r/tree/feature/auth/src');
    expect(
      resolveImage('logo.png', { owner: 'o', name: 'r', ref: 'feature/auth', dir: 'docs' }),
    ).toBe('https://raw.githubusercontent.com/o/r/feature/auth/docs/logo.png');
    expect(
      resolveLink('guia.md#setup', { owner: 'o', name: 'r', ref: 'feature/auth', dir: '' }),
    ).toEqual({
      kind: 'route',
      route: { view: 'file', owner: 'o', name: 'r', ref: 'feature/auth', path: 'guia.md' },
      hash: 'setup',
    });
  });
});

describe('RouteHistory', () => {
  const repo: Route = { view: 'repo', owner: 'o', name: 'r', tab: 'code' };
  const issue: Route = { view: 'issue', owner: 'o', name: 'r', number: 1 };

  it('volta, avança e descarta o que estava à frente ao navegar', () => {
    const history = new RouteHistory();
    history.push(repo);
    history.push(issue);
    expect(history.back()).toEqual(repo);
    expect(history.canForward).toBe(true);
    history.push({ view: 'notifications' });
    expect(history.canForward).toBe(false);
    expect(history.back()).toEqual(repo);
    expect(history.back()).toEqual({ view: 'home' });
    expect(history.canBack).toBe(false);
  });

  it('não empilha a mesma rota e respeita o limite', () => {
    const history = new RouteHistory({ view: 'home' }, 3);
    history.push(repo);
    history.push({ ...repo });
    expect(history.back()).toEqual({ view: 'home' });
    history.forward();
    history.push(issue);
    history.push({ view: 'notifications' });
    history.back();
    history.back();
    expect(history.canBack).toBe(false);
    expect(history.current).toEqual(repo);
  });

  it('dá chaves iguais para rotas iguais', () => {
    expect(routeKey({ ...repo, owner: 'O' })).toBe(routeKey(repo));
    expect(routeKey({ ...repo, state: 'open' })).toBe(routeKey(repo));
    expect(routeKey({ ...repo, tab: 'issues' })).not.toBe(routeKey(repo));
  });
});

describe('breadcrumbs', () => {
  it('monta o caminho de um arquivo com as pastas navegáveis', () => {
    const crumbs = breadcrumbs({ view: 'file', owner: 'o', name: 'r', path: 'src/lib/a.ts' });
    expect(crumbs.map((c) => c.label)).toEqual(['o', 'r', 'src', 'lib', 'a.ts']);
    expect(crumbs[3]?.route).toEqual({
      view: 'repo',
      owner: 'o',
      name: 'r',
      tab: 'code',
      path: 'src/lib',
    });
    expect(crumbs[4]?.route).toBeUndefined();
  });
});

describe('mensagens da webview', () => {
  it('aceita só rotas e mensagens bem formadas', () => {
    expect(parseFromWebview({ type: 'navigate', route: { view: 'user', login: 'octo' } })).toEqual({
      type: 'navigate',
      route: { view: 'user', login: 'octo' },
    });
    expect(
      parseFromWebview({
        type: 'navigate',
        route: { view: 'repo', owner: '../x', name: 'r', tab: 'code' },
      }),
    ).toBeUndefined();
    expect(
      parseRoute({ view: 'file', owner: 'o', name: 'r', path: 'a/../../etc/passwd' }),
    ).toBeUndefined();
    expect(parseRoute({ view: 'pull', owner: 'o', name: 'r', number: -1 })).toBeUndefined();
    expect(parseRoute({ view: 'pull', owner: 'o', name: 'r', number: 2, tab: 'x' })).toEqual({
      view: 'pull',
      owner: 'o',
      name: 'r',
      number: 2,
      tab: 'conversation',
    });
    expect(parseFromWebview({ type: 'external', url: 'javascript:alert(1)' })).toBeUndefined();
    expect(parseFromWebview({ type: 'external', url: 'https://x.dev' })).toEqual({
      type: 'external',
      url: 'https://x.dev/',
    });
    expect(parseFromWebview({ type: 'action', action: 'rm -rf' })).toBeUndefined();
    const comment = { type: 'comment', id: 'c1', key: 'o/r/issue/1', number: 1, body: 'oi' };
    expect(parseFromWebview(comment)).toEqual(comment);
    expect(parseFromWebview({ ...comment, body: '   ' })).toBeUndefined();
    expect(parseFromWebview({ ...comment, body: 'x'.repeat(65_537) })).toBeUndefined();
    expect(parseFromWebview({ ...comment, id: '<img>' })).toBeUndefined();
    expect(parseFromWebview({ ...comment, number: 0 })).toBeUndefined();
    expect(parseFromWebview({ type: 'more', key: 'o/r/issues@:?open' })).toEqual({
      type: 'more',
      key: 'o/r/issues@:?open',
    });
    expect(parseFromWebview({ type: 'more' })).toBeUndefined();
    expect(parseFromWebview({ type: 'markRead', id: '123' })).toEqual({
      type: 'markRead',
      id: '123',
    });
    expect(parseFromWebview({ type: 'markRead', id: '../1' })).toBeUndefined();
    expect(parseFromWebview('ready')).toBeUndefined();
  });
});

describe('modelos das telas', () => {
  it('dá o estado do PR e da execução', () => {
    expect(pullState({ state: 'closed', merged_at: '2026-01-01' })).toBe('merged');
    expect(pullState({ state: 'open', draft: true })).toBe('draft');
    expect(pullState({ state: 'closed' })).toBe('closed');
    expect(runState('in_progress', null)).toBe('running');
    expect(runState('queued', null)).toBe('queued');
    expect(runState('completed', 'timed_out')).toBe('failure');
    expect(runState('completed', 'skipped')).toBe('cancelled');
  });

  it('escolhe a tinta do rótulo pela cor', () => {
    expect(labelInk('#ffffff')).toBe('dark');
    expect(labelInk('fbca04')).toBe('dark');
    expect(labelInk('#0e1a3a')).toBe('light');
    expect(labelInk(undefined)).toBe('light');
  });

  it('calcula a parte de cada linguagem', () => {
    expect(languageShares({ TypeScript: 750, CSS: 200, Shell: 50 }, 2)).toEqual([
      { name: 'TypeScript', percent: 75 },
      { name: 'CSS', percent: 20 },
      { name: 'Other', percent: 5 },
    ]);
    expect(languageShares({})).toEqual([]);
  });

  it('junta comentários e revisões em ordem e esconde envelopes vazios', () => {
    const user = { login: 'ana', id: 1 };
    const comments = [
      { id: 1, body: 'b', user, created_at: '2026-01-02T00:00:00Z', html_url: '' },
    ] as GhComment[];
    const reviews = [
      { id: 2, user, state: 'APPROVED', body: '', submitted_at: '2026-01-03T00:00:00Z' },
      { id: 3, user, state: 'COMMENTED', body: '', submitted_at: '2026-01-01T00:00:00Z' },
      { id: 4, user, state: 'COMMENTED', body: 'a', submitted_at: '2026-01-01T00:00:00Z' },
    ] as GhReview[];
    expect(timeline(comments, reviews).map((e) => e.body || e.review)).toEqual([
      'a',
      'b',
      'APPROVED',
    ]);
  });

  it('agrupa notificações com rota no painel', () => {
    const n = (id: string, repo: string, updated: string, url: string): GhNotification => ({
      id,
      unread: id !== '2',
      reason: 'review_requested',
      updated_at: updated,
      subject: { title: `t${id}`, type: 'PullRequest', url },
      repository: { full_name: repo, html_url: `https://github.com/${repo}` },
    });
    const groups = notificationGroups([
      n('1', 'o/a', '2026-01-01T00:00:00Z', 'https://api.github.com/repos/o/a/pulls/4'),
      n('2', 'o/b', '2026-01-03T00:00:00Z', 'https://api.github.com/repos/o/b/issues/9'),
    ]);
    expect(groups.map((g) => [g.repo, g.unread])).toEqual([
      ['o/b', 0],
      ['o/a', 1],
    ]);
    expect(groups[1]?.items[0]).toMatchObject({
      reason: 'review requested',
      url: 'https://github.com/o/a/pull/4',
      route: { view: 'pull', owner: 'o', name: 'a', number: 4 },
    });
  });

  it('formata tempo, tamanho e contadores', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(relativeTime('2026-10-14T11:59:50Z', now)).toBe('now');
    expect(relativeTime('2026-10-14T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-13T12:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2024-10-14T12:00:00Z', now)).toBe('2 years ago');
    expect(formatBytes(820)).toBe('820 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1023.95 * 1024)).toBe('1024.0 KB');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234)).toBe('1.2k');
    expect(formatCount(56_000)).toBe('56k');
    expect(formatCount(3_400_000)).toBe('3.4M');
    expect(formatDuration(185)).toBe('3 min 05 s');
  });
});

describe('textos em pt-BR', () => {
  afterEach(() => useLocale('en'));

  it('formata tempo, tamanho e contadores em pt-BR', () => {
    useLocale('pt-br');
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(relativeTime('2026-10-14T11:59:50Z', now)).toBe('agora');
    expect(relativeTime('2026-10-14T11:55:00Z', now)).toBe('há 5 min');
    expect(relativeTime('2026-10-14T09:00:00Z', now)).toBe('há 3 h');
    expect(relativeTime('2026-10-13T12:00:00Z', now)).toBe('ontem');
    expect(relativeTime('2026-10-10T12:00:00Z', now)).toBe('há 4 dias');
    expect(relativeTime('2026-09-14T12:00:00Z', now)).toBe('há 1 mês');
    expect(relativeTime('2026-06-14T12:00:00Z', now)).toBe('há 4 meses');
    expect(relativeTime('2024-10-14T12:00:00Z', now)).toBe('há 2 anos');
    expect(formatBytes(2048)).toBe('2,0 KB');
    expect(formatBytes(1023.95 * 1024)).toBe('1024,0 KB');
    expect(formatCount(1234)).toBe('1,2 mil');
    expect(formatCount(56_000)).toBe('56 mil');
    expect(formatCount(3_400_000)).toBe('3,4 mi');
  });

  it('dá nomes de abas, títulos e caminhos em pt-BR', () => {
    useLocale('pt-br');
    expect(userTabLabel('overview')).toBe('Visão geral');
    // O objeto lê o idioma na hora, não na carga do módulo.
    expect(USER_TAB_LABELS.followers).toBe('Seguidores');
    expect(routeTitle({ view: 'user', login: 'octo', tab: 'stars' })).toBe('octo: estrelas');
    expect(routeTitle({ view: 'notifications' })).toBe('GitHub: notificações');
    expect(routeTitle({ view: 'run', owner: 'o', name: 'r', id: 7 })).toBe('r: execução');
    expect(breadcrumbs({ view: 'search', q: 'vite' }).map((c) => c.label)).toEqual([
      'Início',
      'Busca: vite',
    ]);
    expect(breadcrumbs({ view: 'run', owner: 'o', name: 'r', id: 7 }).at(-1)?.label).toBe(
      'Execução 7',
    );
    expect(languageShares({ TypeScript: 750, CSS: 200, Shell: 50 }, 2).at(-1)?.name).toBe('Outras');
    expect(new StaleSessionError().message).toBe(
      'A conta do GitHub mudou durante a leitura. Atualize a página.',
    );
  });
});
