/** Acesso mínimo à API do GitHub para preparar o repositório de sync. */

import { l10n } from '@fakl/i18n';

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

const REPO_PATTERN = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

/** Aceita `dono/nome`, a URL https ou a URL ssh do repositório. */
export function parseRepository(input: string): RepositoryRef | undefined {
  const cleaned = input
    .trim()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const match = REPO_PATTERN.exec(cleaned);
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: match[1], name: match[2] };
}

export function cloneUrl(repo: RepositoryRef): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class GitHubApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  }

  async login(): Promise<string> {
    const response = await this.request('/user');
    if (!response.ok)
      throw new Error(l10n.t('GitHub rejected the sign-in ({0})', String(response.status)));
    const user = (await response.json()) as { login: string };
    return user.login;
  }

  /** `private` do repositório, ou undefined se ele não existe ou não é visível. */
  async repositoryVisibility(repo: RepositoryRef): Promise<{ private: boolean } | undefined> {
    const response = await this.request(`/repos/${repo.owner}/${repo.name}`);
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(
        l10n.t('Failed to query {0}/{1} ({2})', repo.owner, repo.name, String(response.status)),
      );
    const data = (await response.json()) as { private: boolean };
    return { private: data.private };
  }

  /** Cria um repositório privado na conta do usuário logado. */
  async createPrivateRepository(name: string): Promise<void> {
    const response = await this.request('/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name,
        private: true,
        description: l10n.t('FaKL-Code IDE synced settings'),
        auto_init: false,
      }),
    });
    if (!response.ok)
      throw new Error(
        l10n.t('Failed to create the repository {0} ({1})', name, String(response.status)),
      );
  }
}
