import { useLocale } from '@fakl/i18n';
import type { GhNotification, GhRepo } from '@fakl/integrations';
import { afterEach, describe, expect, it } from 'vitest';

import {
  filterRepos,
  groupByOwner,
  groupNotifications,
  RUN_FILTERS,
  runFilterLabel,
  summarizeRunErrors,
  unreadCount,
} from '../src/github-model.js';

const repo = (full: string, description?: string): GhRepo => ({
  full_name: full,
  default_branch: 'main',
  private: false,
  html_url: `https://github.com/${full}`,
  owner: { login: full.split('/')[0] ?? '' },
  ...(description ? { description } : {}),
});

const note = (id: string, full: string, updated: string, unread = true): GhNotification => ({
  id,
  unread,
  reason: 'review_requested',
  updated_at: updated,
  subject: { title: `t${id}`, type: 'PullRequest' },
  repository: { full_name: full, html_url: `https://github.com/${full}` },
});

afterEach(() => {
  useLocale('en');
});

describe('groupByOwner', () => {
  it('põe o usuário primeiro, depois as orgs e as colaborações', () => {
    const groups = groupByOwner(
      'ana',
      [
        { login: 'acme', id: 1 },
        { login: 'vazia', id: 2 },
      ],
      [repo('acme/web'), repo('ana/app'), repo('bob/lib'), repo('Acme/api')],
    );
    expect(groups.map((g) => [g.login, g.kind, g.repos.length])).toEqual([
      ['ana', 'user', 1],
      ['acme', 'org', 2],
      ['vazia', 'org', 0],
      ['Collaborations', 'colab', 1],
    ]);
  });

  it('nomeia o grupo de colaborações em pt-BR', () => {
    useLocale('pt-br');
    expect(groupByOwner('ana', [], [repo('bob/lib')]).at(-1)?.login).toBe('Colaborações');
  });

  it('omite colaborações quando não há', () => {
    expect(groupByOwner('ana', [], [repo('ana/a')])).toHaveLength(1);
  });
});

describe('filterRepos', () => {
  const repos = [repo('ana/blog', 'Meu site'), repo('acme/api'), repo('acme/web')];
  it('busca no nome e na descrição, sem maiúsculas', () => {
    expect(filterRepos(repos, 'ACME').map((r) => r.full_name)).toEqual(['acme/api', 'acme/web']);
    expect(filterRepos(repos, 'site').map((r) => r.full_name)).toEqual(['ana/blog']);
  });
  it('texto vazio devolve tudo', () => {
    expect(filterRepos(repos, '  ')).toHaveLength(3);
  });
});

describe('notificações', () => {
  const list = [
    note('1', 'a/x', '2026-10-01T10:00:00Z'),
    note('2', 'b/y', '2026-10-03T10:00:00Z'),
    note('3', 'a/x', '2026-10-02T10:00:00Z', false),
  ];
  it('agrupa por repositório, mais recente primeiro', () => {
    const groups = groupNotifications(list);
    expect(groups.map((g) => g.repo)).toEqual(['b/y', 'a/x']);
    expect(groups[1]?.items.map((n) => n.id)).toEqual(['3', '1']);
    expect(groups[1]?.unread).toBe(1);
  });
  it('conta não lidas', () => {
    expect(unreadCount(list)).toBe(2);
  });
});

describe('summarizeRunErrors', () => {
  it('resume e destaca SSO', () => {
    expect(summarizeRunErrors([])).toBeUndefined();
    expect(
      summarizeRunErrors([
        { repo: 'a/b', message: 'GitHub 403: a organização exige SSO' },
        { repo: 'c/d', message: 'GitHub 404' },
      ]),
    ).toBe('2 repositories could not be read (1 needs SSO authorization)');
  });

  it('usa singular e plural', () => {
    const sso = { repo: 'a/b', message: 'exige SSO' };
    const other = { repo: 'c/d', message: 'GitHub 404' };
    expect(summarizeRunErrors([other])).toBe('1 repository could not be read');
    expect(summarizeRunErrors([sso])).toBe(
      '1 repository could not be read (it needs SSO authorization)',
    );
    expect(summarizeRunErrors([sso, sso, other])).toBe(
      '3 repositories could not be read (2 need SSO authorization)',
    );
  });

  it('resume em pt-BR', () => {
    useLocale('pt-br');
    const sso = { repo: 'a/b', message: 'exige SSO' };
    const other = { repo: 'c/d', message: 'GitHub 404' };
    expect(summarizeRunErrors([other])).toBe('1 repositório não pôde ser lido');
    expect(summarizeRunErrors([sso, other])).toBe(
      '2 repositórios não puderam ser lidos (1 pede autorização de SSO)',
    );
  });
});

describe('runFilterLabel', () => {
  it('rotula os filtros no idioma atual', () => {
    expect(RUN_FILTERS.map((f) => runFilterLabel(f.id))).toEqual([
      'All',
      'Failed',
      'In progress',
      'Succeeded',
    ]);
    useLocale('pt-br');
    expect(RUN_FILTERS.map((f) => runFilterLabel(f.id))).toEqual([
      'Todas',
      'Falhou',
      'Em andamento',
      'Com sucesso',
    ]);
  });
});
