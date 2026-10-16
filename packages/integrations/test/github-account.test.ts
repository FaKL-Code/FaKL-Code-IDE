import { describe, expect, it } from 'vitest';

import {
  accountQuery,
  explainGitHubError,
  GitHubClient,
  GitHubError,
  mapLimit,
  nextLink,
  type FetchLike,
} from '../src/index.js';

type Handler = (url: string, init: RequestInit | undefined) => Response;

function routed(handler: Handler): { fetch: FetchLike; urls: string[]; inits: RequestInit[] } {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  return {
    urls,
    inits,
    fetch: (url, init) => {
      urls.push(url);
      inits.push(init ?? {});
      return Promise.resolve(handler(url, init));
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const run = (id: number, created: string) => ({
  id,
  head_branch: 'main',
  head_sha: 'abc',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/x/y/actions/runs/${String(id)}`,
  run_number: id,
  created_at: created,
  updated_at: created,
});

describe('paginação e helpers', () => {
  it('lê o rel="next" do Link', () => {
    expect(
      nextLink(
        '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"',
      ),
    ).toBe('https://api.github.com/user/repos?page=2');
    expect(nextLink('<https://x?page=1>; rel="prev"')).toBeUndefined();
    expect(nextLink(null)).toBeUndefined();
  });

  it('mapLimit respeita a concorrência e a ordem', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });

  it('monta as consultas da conta', () => {
    expect(accountQuery('reviewRequested', 'pr')).toBe(
      'is:open is:pr review-requested:@me archived:false',
    );
    expect(accountQuery('assigned', 'all')).toBe('is:open assignee:@me archived:false');
    expect(accountQuery('authored', 'issue', 'all')).toBe('is:issue author:@me archived:false');
  });
});

describe('GitHubClient: conta inteira', () => {
  it('segue a paginação por Link ao listar os repositórios', async () => {
    const { fetch, urls } = routed((url) =>
      url.includes('page=2')
        ? json([{ full_name: 'o/b' }])
        : json([{ full_name: 'o/a' }], 200, {
            link: '<https://api.github.com/user/repos?page=2>; rel="next"',
          }),
    );
    const client = new GitHubClient({ token: () => 't', fetch });
    const repos = await client.userRepos();
    expect(repos.map((r) => r.full_name)).toEqual(['o/a', 'o/b']);
    expect(urls[0]).toContain('/user/repos?');
    expect(urls[0]).toContain('affiliation=owner,collaborator,organization_member');
    expect(urls).toHaveLength(2);
  });

  it('respeita maxPages', async () => {
    const { fetch, urls } = routed(() =>
      json([{ id: 1 }], 200, { link: '<https://api.github.com/user/orgs?page=2>; rel="next"' }),
    );
    const client = new GitHubClient({ token: () => 't', fetch });
    await client.userOrgs({ maxPages: 1 });
    expect(urls).toHaveLength(1);
  });

  it('não manda o token para uma URL fora da API', async () => {
    const { fetch, urls } = routed(() =>
      json([{ id: 1 }], 200, { link: '<https://evil.example/steal>; rel="next"' }),
    );
    const client = new GitHubClient({ token: () => 't', fetch });
    await expect(client.userOrgs()).rejects.toThrow('fora da API');
    expect(urls).toEqual(['https://api.github.com/user/orgs?per_page=100']);
  });

  it('lista repositórios de uma organização', async () => {
    const { fetch, urls } = routed(() => json([{ full_name: 'acme/x' }]));
    const client = new GitHubClient({ token: () => 't', fetch });
    expect(await client.orgRepos('acme')).toHaveLength(1);
    expect(urls[0]).toContain('/orgs/acme/repos');
  });

  it('busca PRs da conta e resolve repositório e tipo', async () => {
    const { fetch, urls } = routed(() =>
      json({
        total_count: 2,
        items: [
          {
            number: 5,
            title: 'Pede revisão',
            state: 'open',
            html_url: 'https://github.com/acme/web/pull/5',
            user: { login: 'ana', id: 1 },
            labels: [{ name: 'bug' }],
            comments: 2,
            updated_at: '2026-10-01T00:00:00Z',
            repository_url: 'https://api.github.com/repos/acme/web',
            pull_request: {},
            draft: true,
          },
          {
            number: 9,
            title: 'Issue',
            state: 'open',
            html_url: 'https://github.com/me/app/issues/9',
            user: null,
            labels: [],
            comments: 0,
            updated_at: '2026-10-02T00:00:00Z',
            repository_url: 'https://api.github.com/repos/me/app',
          },
        ],
      }),
    );
    const client = new GitHubClient({ token: () => 't', fetch });
    const { total, items } = await client.accountItems('reviewRequested', 'all');
    expect(total).toBe(2);
    expect(items[0]).toMatchObject({
      repo: 'acme/web',
      kind: 'pr',
      draft: true,
      author: 'ana',
      labels: ['bug'],
    });
    expect(items[1]).toMatchObject({ repo: 'me/app', kind: 'issue', author: undefined });
    const q = new URL(urls[0] ?? '').searchParams.get('q');
    expect(q).toBe('is:open review-requested:@me archived:false');
  });

  it('usa ETag também nas buscas', async () => {
    let n = 0;
    const { fetch, inits } = routed(() =>
      n++ === 0
        ? json({ total_count: 0, items: [] }, 200, { etag: '"s1"' })
        : new Response(null, { status: 304 }),
    );
    const client = new GitHubClient({ token: () => 't', fetch });
    await client.searchIssues('is:open');
    const again = await client.searchIssues('is:open');
    expect(again.items).toEqual([]);
    expect((inits[1]?.headers as Record<string, string>)['if-none-match']).toBe('"s1"');
  });
});

describe('GitHubClient: Actions entre repositórios', () => {
  const repos = [
    { full_name: 'o/a', pushed_at: '2026-10-03T00:00:00Z' },
    { full_name: 'o/b', pushed_at: '2026-10-02T00:00:00Z' },
    { full_name: 'o/old', archived: true },
    { full_name: 'o/c' },
    { full_name: 'o/d' },
  ];

  it('limita o fan-out, ordena por data e junta os erros por repositório', async () => {
    const { fetch, urls } = routed((url) => {
      if (url.includes('/user/repos')) return json(repos);
      if (url.includes('/repos/o/a/')) {
        return json({
          workflow_runs: [run(1, '2026-10-05T10:00:00Z'), run(2, '2026-10-05T08:00:00Z')],
        });
      }
      if (url.includes('/repos/o/b/')) {
        return json({ message: 'Actions disabled' }, 404);
      }
      return json({ workflow_runs: [run(3, '2026-10-05T09:00:00Z')] });
    });
    const client = new GitHubClient({ token: () => 't', fetch });
    const result = await client.recentRuns({ maxRepos: 3, perRepo: 2 });
    // o/old (arquivado) fica de fora; maxRepos 3 => a, b, c
    expect(result.repos).toBe(3);
    expect(urls.filter((u) => u.includes('/actions/runs'))).toHaveLength(3);
    expect(urls.some((u) => u.includes('/repos/o/d/'))).toBe(false);
    expect(result.runs.map((r) => [r.id, r.repo])).toEqual([
      [1, 'o/a'],
      [3, 'o/c'],
      [2, 'o/a'],
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.repo).toBe('o/b');
    expect(urls.find((u) => u.includes('/repos/o/a/'))).toContain('per_page=2');
  });

  it('usa só os repositórios pedidos, com status e limite de resultados', async () => {
    const { fetch, urls } = routed(() =>
      json({ workflow_runs: [run(1, '2026-10-05T10:00:00Z'), run(2, '2026-10-05T11:00:00Z')] }),
    );
    const client = new GitHubClient({ token: () => 't', fetch });
    const result = await client.recentRuns({
      repos: [{ owner: 'x', name: 'y' }],
      status: 'failure',
      limit: 1,
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('status=failure');
    expect(result.runs.map((r) => r.id)).toEqual([2]);
  });

  it('não passa da concorrência configurada', async () => {
    let active = 0;
    let peak = 0;
    const fetch: FetchLike = async (url) => {
      if (url.includes('/user/repos')) {
        return json(Array.from({ length: 10 }, (_, i) => ({ full_name: `o/r${String(i)}` })));
      }
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return json({ workflow_runs: [] });
    };
    const client = new GitHubClient({ token: () => 't', fetch });
    await client.recentRuns({ maxRepos: 10, concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('limite de requisições', () => {
  it('não insiste na API com o limite esgotado e serve o cache', async () => {
    let now = 1_000_000;
    let n = 0;
    const { fetch, urls } = routed(() => {
      n++;
      return json([{ id: 1 }], 200, {
        etag: '"a"',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor((now + 120_000) / 1000)),
      });
    });
    const client = new GitHubClient({ token: () => 't', fetch, now: () => now });
    await client.userOrgs();
    // mesmo pedido: devolve o cache sem ir à rede
    expect(await client.userOrgs()).toEqual([{ id: 1 }]);
    // pedido novo: erro claro, sem rede
    await expect(client.userRepos()).rejects.toMatchObject({ kind: 'limite', status: 429 });
    expect(n).toBe(1);
    expect(urls).toHaveLength(1);
    // a janela volta
    now += 200_000;
    await client.userRepos();
    expect(n).toBe(2);
  });

  it('o limite da busca é separado do geral', async () => {
    const { fetch } = routed((url) =>
      url.includes('/search/')
        ? json({ total_count: 0, items: [] }, 200, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
            'x-ratelimit-resource': 'search',
          })
        : json([]),
    );
    const client = new GitHubClient({ token: () => 't', fetch });
    await client.searchIssues('is:open');
    await expect(client.searchIssues('is:pr')).rejects.toMatchObject({ kind: 'limite' });
    expect(await client.userOrgs()).toEqual([]);
  });
});

describe('explainGitHubError', () => {
  it('explica SSO de organização', () => {
    const headers = new Headers({
      'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=1',
    });
    const error = explainGitHubError(403, headers, {
      message: 'Resource protected by organization SAML enforcement.',
    });
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.kind).toBe('sso');
    expect(error.ssoUrl).toBe('https://github.com/orgs/acme/sso?authorization_request=1');
    expect(error.message).toContain('SSO');
    expect(error.message).toContain('Configure SSO');
  });

  it('explica token fine-grained sem acesso', () => {
    const error = explainGitHubError(
      403,
      new Headers({ 'x-accepted-github-permissions': 'actions=read' }),
      { message: 'Resource not accessible by personal access token' },
    );
    expect(error.kind).toBe('token-sem-acesso');
    expect(error.message).toContain('fine-grained');
    expect(error.message).toContain('actions=read');
  });

  it('explica escopo faltando, login expirado e limite', () => {
    expect(
      explainGitHubError(
        403,
        new Headers({ 'x-oauth-scopes': 'repo', 'x-accepted-oauth-scopes': 'notifications' }),
        { message: 'Forbidden' },
      ).kind,
    ).toBe('escopo');
    expect(explainGitHubError(401, new Headers(), { message: 'Bad credentials' }).kind).toBe(
      'login',
    );
    const limit = explainGitHubError(
      403,
      new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' }),
      { message: 'API rate limit exceeded' },
      1_000_000,
    );
    expect(limit.kind).toBe('limite');
    expect(limit.retryAt).toBe(1_060_000);
  });

  it('mantém o formato simples para os demais erros', () => {
    const error = explainGitHubError(404, new Headers(), { message: 'Not Found' });
    expect(error.kind).toBeUndefined();
    expect(error.message).toBe('GitHub 404: Not Found');
  });
});

describe('notificações', () => {
  it('pagina e marca todas como lidas', async () => {
    const { fetch, urls, inits } = routed((url) =>
      url.endsWith('/notifications') ? new Response(null, { status: 205 }) : json([{ id: '1' }]),
    );
    const client = new GitHubClient({ token: () => 't', fetch, now: () => 0 });
    expect(await client.notifications()).toEqual([{ id: '1' }]);
    await client.markNotificationsRead();
    expect(urls[1]).toBe('https://api.github.com/notifications');
    expect(inits[1]?.method).toBe('PUT');
  });
});
