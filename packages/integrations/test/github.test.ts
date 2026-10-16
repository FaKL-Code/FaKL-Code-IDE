import { describe, expect, it } from 'vitest';

import {
  DeviceFlowError,
  GitHubClient,
  HostingerClient,
  HttpError,
  parseGitHubRemote,
  pollDeviceToken,
  type FetchLike,
} from '../src/index.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(responses: (() => Response)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error(`pedido inesperado: ${url}`);
      return Promise.resolve(next());
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/FaKL-Code/FaKL-Code-IDE.git', 'FaKL-Code', 'FaKL-Code-IDE'],
    ['https://x-access-token:abc@github.com/o/r', 'o', 'r'],
    ['git@github.com:o/r.git', 'o', 'r'],
    ['ssh://git@github.com/o/r.git', 'o', 'r'],
  ])('%s', (url, owner, name) => {
    expect(parseGitHubRemote(url)).toEqual({ owner, name });
  });

  it('ignora outros servidores', () => {
    expect(parseGitHubRemote('https://gitlab.com/o/r.git')).toBeUndefined();
  });
});

describe('GitHubClient', () => {
  it('manda o token e reaproveita a resposta com ETag', async () => {
    const { fetch, calls } = fakeFetch([
      () => json([{ number: 1 }], 200, { etag: 'W/"1"', 'x-ratelimit-remaining': '4999' }),
      () => new Response(null, { status: 304 }),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    const repo = { owner: 'o', name: 'r' };
    expect(await client.pulls(repo)).toEqual([{ number: 1 }]);
    expect(await client.pulls(repo)).toEqual([{ number: 1 }]);
    const headers = calls[1]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['if-none-match']).toBe('W/"1"');
    expect(client.rateRemaining).toBe(4999);
  });

  it('separa issues de PRs e traduz erros', async () => {
    const { fetch } = fakeFetch([
      () => json([{ number: 1 }, { number: 2, pull_request: {} }]),
      () => json({ message: 'Not Found' }, 404),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    const repo = { owner: 'o', name: 'r' };
    expect((await client.issues(repo)).map((i) => i.number)).toEqual([1]);
    await expect(client.pull(repo, 9)).rejects.toThrow('GitHub 404: Not Found');
  });

  it('lista uma pasta com as pastas primeiro e codifica o caminho', async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        json([
          { type: 'file', name: 'b.md', path: 'docs/b.md', sha: '1', size: 3 },
          { type: 'dir', name: 'z', path: 'docs/z', sha: '2', size: 0 },
          { type: 'file', name: 'A.md', path: 'docs/A.md', sha: '3', size: 3 },
        ]),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    const list = await client.contents({ owner: 'o', name: 'r' }, 'docs/', 'feat/x');
    expect(Array.isArray(list) && list.map((item) => item.name)).toEqual(['z', 'A.md', 'b.md']);
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/contents/docs?ref=feat%2Fx');
  });

  it('decodifica o README em base64 e devolve undefined sem README', async () => {
    const text = 'Olá, **mundo** ✓';
    const content = Buffer.from(text)
      .toString('base64')
      .replace(/(.{8})/g, '$1\n');
    const { fetch, calls } = fakeFetch([
      () =>
        json({
          type: 'file',
          name: 'README.md',
          path: 'README.md',
          sha: 's',
          size: 10,
          content,
          encoding: 'base64',
        }),
      () => json({ message: 'Not Found' }, 404),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    const repo = { owner: 'o', name: 'r' };
    expect(await client.readme(repo, 'main')).toEqual({ path: 'README.md', text });
    expect(await client.readme(repo, undefined, 'pkg/a b')).toBeUndefined();
    expect(calls[0]?.url).toBe('https://api.github.com/repos/o/r/readme?ref=main');
    expect(calls[1]?.url).toBe('https://api.github.com/repos/o/r/readme/pkg/a%20b');
  });

  it('monta as consultas de commits, busca, perfil e checks', async () => {
    const { fetch, calls } = fakeFetch([
      () => json([{ sha: 'a' }]),
      () => json({ total_count: 1, items: [{ full_name: 'o/r' }] }),
      () => json({ login: 'octo', type: 'User' }),
      () => json({ check_runs: [{ id: 1, name: 'ci' }] }),
      () => json({ TypeScript: 10 }),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    const repo = { owner: 'o', name: 'r' };
    await client.commits(repo, { ref: 'main', path: 'src/a.ts', perPage: 1 });
    expect((await client.searchRepos('fakl lang:ts')).total).toBe(1);
    expect((await client.profile('octo')).type).toBe('User');
    expect(await client.checkRuns(repo, 'abc')).toEqual([{ id: 1, name: 'ci' }]);
    expect(await client.languages(repo)).toEqual({ TypeScript: 10 });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/o/r/commits?per_page=1&sha=main&path=src%2Fa.ts',
      'https://api.github.com/search/repositories?q=fakl%20lang%3Ats&per_page=20',
      'https://api.github.com/users/octo',
      'https://api.github.com/repos/o/r/commits/abc/check-runs?per_page=100',
      'https://api.github.com/repos/o/r/languages',
    ]);
  });

  it('pagina as listas pelo cabeçalho Link, mesmo com issues filtradas', async () => {
    const next = { link: '<https://api.github.com/repos/o/r/issues?page=3>; rel="next"' };
    const { fetch, calls } = fakeFetch([
      () => json([{ number: 1, pull_request: {} }, { number: 2 }], 200, next),
      () => json({ workflow_runs: [{ id: 9 }] }),
      () => json([{ full_name: 'acme/x' }], 200, next),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    const repo = { owner: 'o', name: 'r' };
    const issues = await client.issuesPage(repo, 'closed', 2, 2);
    expect(issues).toEqual({ items: [{ number: 2 }], hasMore: true });
    expect(await client.runsPage(repo, 1)).toEqual({ items: [{ id: 9 }], hasMore: false });
    expect((await client.ownerReposPage('acme', 'org', 4)).hasMore).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/o/r/issues?state=closed&per_page=2&page=2&sort=updated',
      'https://api.github.com/repos/o/r/actions/runs?per_page=30&page=1',
      'https://api.github.com/orgs/acme/repos?sort=pushed&direction=desc&per_page=30&page=4',
    ]);
  });

  it('lê todos os repositórios do perfil até o limite de páginas', async () => {
    const next = { link: '<https://api.github.com/user/repos?page=2>; rel="next"' };
    const { fetch, calls } = fakeFetch([
      () => json([{ full_name: 'me/a' }], 200, next),
      () => json([{ full_name: 'me/b' }], 200, next),
      () => json([{ full_name: 'octo/c' }]),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    expect(await client.ownerReposAll('me', 'mine', 2)).toEqual({
      items: [{ full_name: 'me/a' }, { full_name: 'me/b' }],
      hasMore: true,
    });
    expect(await client.ownerReposAll('octo', 'user')).toEqual({
      items: [{ full_name: 'octo/c' }],
      hasMore: false,
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=100&page=1',
      'https://api.github.com/user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=100&page=2',
      'https://api.github.com/users/octo/repos?sort=pushed&direction=desc&per_page=100&page=1',
    ]);
  });

  it('monta as listas de estrelas, pessoas e organizações do perfil', async () => {
    const { fetch, calls } = fakeFetch([
      () => json([{ full_name: 'o/r' }]),
      () => json([{ login: 'a', id: 1 }]),
      () => json([{ login: 'b', id: 2 }]),
      () => json([{ login: 'acme', id: 3 }]),
      () => json([{ login: 'acme', id: 3 }]),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    expect((await client.starredPage('octo', 2)).items).toEqual([{ full_name: 'o/r' }]);
    expect((await client.peoplePage('octo', 'followers', 1)).items[0]?.login).toBe('a');
    expect((await client.peoplePage('acme', 'members', 3, 10)).hasMore).toBe(false);
    await client.profileOrgs('octo', false);
    await client.profileOrgs('me', true);
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.github.com/users/octo/starred?per_page=30&page=2',
      'https://api.github.com/users/octo/followers?per_page=30&page=1',
      'https://api.github.com/orgs/acme/members?per_page=10&page=3',
      'https://api.github.com/users/octo/orgs?per_page=100',
      'https://api.github.com/user/orgs?per_page=100',
    ]);
  });

  it('lê os fixados pelo GraphQL no formato da REST', async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        json({
          data: {
            repositoryOwner: {
              pinnedItems: {
                nodes: [
                  {
                    nameWithOwner: 'octo/hello',
                    url: 'https://github.com/octo/hello',
                    description: 'Oi',
                    isPrivate: false,
                    isFork: false,
                    isArchived: false,
                    stargazerCount: 12,
                    forkCount: 3,
                    pushedAt: '2026-01-01T00:00:00Z',
                    defaultBranchRef: { name: 'main' },
                    primaryLanguage: { name: 'Go', color: '#00ADD8' },
                  },
                  {},
                ],
              },
              starredRepositories: { totalCount: 40 },
            },
          },
        }),
      () => json({ data: { repositoryOwner: null }, errors: [{ message: 'Could not resolve' }] }),
    ]);
    const client = new GitHubClient({ token: () => 'tok', fetch });
    const extras = await client.profileExtras('octo');
    expect(extras.stars).toBe(40);
    expect(extras.pinned).toEqual([
      {
        full_name: 'octo/hello',
        default_branch: 'main',
        private: false,
        html_url: 'https://github.com/octo/hello',
        description: 'Oi',
        fork: false,
        archived: false,
        pushed_at: '2026-01-01T00:00:00Z',
        language: 'Go',
        language_color: '#00ADD8',
        stargazers_count: 12,
        forks_count: 3,
      },
    ]);
    await expect(client.profileExtras('ninguem')).rejects.toThrow('Could not resolve');
    expect(calls[0]?.url).toBe('https://api.github.com/graphql');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toMatchObject({
      variables: { login: 'octo' },
    });
  });

  it('recusa sem login', async () => {
    const client = new GitHubClient({
      token: () => undefined,
      fetch: () => Promise.reject(new Error('x')),
    });
    await expect(client.user()).rejects.toBeInstanceOf(HttpError);
  });
});

describe('device flow', () => {
  it('espera a autorização respeitando slow_down', async () => {
    const { fetch, calls } = fakeFetch([
      () => json({ error: 'authorization_pending' }),
      () => json({ error: 'slow_down', interval: 10 }),
      () => json({ access_token: 'gho_x' }),
    ]);
    const waits: number[] = [];
    const token = await pollDeviceToken(
      'cid',
      { deviceCode: 'dc', userCode: 'AB-CD', verificationUri: 'u', expiresIn: 900, interval: 5 },
      { fetch, sleep: (ms) => (waits.push(ms), Promise.resolve()), now: () => 0 },
    );
    expect(token).toBe('gho_x');
    expect(waits).toEqual([5000, 5000, 10000]);
    expect(calls[0]?.init?.body as string).toContain('device_code=dc');
  });

  it('para quando o login é negado', async () => {
    const { fetch } = fakeFetch([() => json({ error: 'access_denied' })]);
    await expect(
      pollDeviceToken(
        'cid',
        { deviceCode: 'dc', userCode: 'x', verificationUri: 'u', expiresIn: 900, interval: 1 },
        { fetch, sleep: () => Promise.resolve(), now: () => 0 },
      ),
    ).rejects.toBeInstanceOf(DeviceFlowError);
  });
});

describe('HostingerClient', () => {
  it('cria snapshot e espera a ação terminar', async () => {
    const { fetch, calls } = fakeFetch([
      () => json({ id: 7, name: 'snapshot', state: 'created' }),
      () => json({ id: 7, name: 'snapshot', state: 'sent' }),
      () => json({ id: 7, name: 'snapshot', state: 'success' }),
    ]);
    const client = new HostingerClient({ token: () => 'h', fetch });
    const action = await client.createSnapshot(42);
    const done = await client.waitAction(42, action.id, { sleep: () => Promise.resolve() });
    expect(done.state).toBe('success');
    expect(calls[0]?.url).toBe(
      'https://developers.hostinger.com/api/vps/v1/virtual-machines/42/snapshot',
    );
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('manda o corpo certo para atualizar DNS', async () => {
    const { fetch, calls } = fakeFetch([() => json({ message: 'ok' })]);
    const client = new HostingerClient({ token: () => 'h', fetch });
    await client.updateDns('exemplo.com', [
      { name: 'www', type: 'A', ttl: 300, records: [{ content: '1.2.3.4' }] },
    ]);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      overwrite: true,
      zone: [{ name: 'www', type: 'A', ttl: 300, records: [{ content: '1.2.3.4' }] }],
    });
  });
});
