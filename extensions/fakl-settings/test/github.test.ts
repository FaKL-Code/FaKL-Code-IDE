import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cloneUrl, GitHubApi, parseRepository } from '../src/github.js';

describe('parseRepository', () => {
  it('aceita dono/nome e URLs do GitHub', () => {
    const expected = { owner: 'FaKL-Code', name: 'fakl-settings' };
    expect(parseRepository('FaKL-Code/fakl-settings')).toEqual(expected);
    expect(parseRepository(' https://github.com/FaKL-Code/fakl-settings.git ')).toEqual(expected);
    expect(parseRepository('https://github.com/FaKL-Code/fakl-settings/')).toEqual(expected);
    expect(parseRepository('git@github.com:FaKL-Code/fakl-settings.git')).toEqual(expected);
  });

  it('recusa entradas que não são um repositório', () => {
    expect(parseRepository('')).toBeUndefined();
    expect(parseRepository('fakl-settings')).toBeUndefined();
    expect(parseRepository('a/b/c')).toBeUndefined();
    expect(parseRepository('https://gitlab.com/a/b')).toBeUndefined();
  });

  it('monta a URL https de clone', () => {
    expect(cloneUrl({ owner: 'a', name: 'b' })).toBe('https://github.com/a/b.git');
  });
});

describe('GitHubApi', () => {
  function respond(status: number, body: unknown = {}) {
    return vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    );
  }

  it('envia o token e lê o login', async () => {
    const fetchMock = respond(200, { login: 'FaKL-Code' });
    expect(await new GitHubApi('tok', fetchMock).login()).toBe('FaKL-Code');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/user');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('distingue repositório inexistente de privado', async () => {
    const repo = { owner: 'a', name: 'b' };
    expect(await new GitHubApi('t', respond(404)).repositoryVisibility(repo)).toBeUndefined();
    expect(
      await new GitHubApi('t', respond(200, { private: true })).repositoryVisibility(repo),
    ).toEqual({
      private: true,
    });
    await expect(new GitHubApi('t', respond(500)).repositoryVisibility(repo)).rejects.toThrow(
      /500/,
    );
  });

  it('cria o repositório sempre privado', async () => {
    const fetchMock = respond(201);
    await new GitHubApi('t', fetchMock).createPrivateRepository('fakl-settings');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/user/repos');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      name: 'fakl-settings',
      private: true,
    });
    await expect(new GitHubApi('t', respond(422)).createPrivateRepository('x')).rejects.toThrow(
      /422/,
    );
  });

  describe('mensagens de erro', () => {
    afterEach(() => {
      useLocale('en');
    });

    it('explica a recusa em inglês e em pt-BR', async () => {
      await expect(new GitHubApi('t', respond(401)).login()).rejects.toThrow(
        'GitHub rejected the sign-in (401)',
      );
      useLocale('pt-br');
      await expect(new GitHubApi('t', respond(401)).login()).rejects.toThrow(
        'GitHub recusou o login (401)',
      );
      await expect(new GitHubApi('t', respond(422)).createPrivateRepository('x')).rejects.toThrow(
        'Falha ao criar o repositório x (422)',
      );
    });
  });
});
