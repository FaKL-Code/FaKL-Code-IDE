import type { CiStatus } from '@fakl/protocol';
import { describe, expect, it } from 'vitest';

import { parseRepoInput, repoChoices, statusBarView } from '../src/ci-model.js';

function status(extra: Partial<CiStatus> = {}): CiStatus {
  return {
    conectado: true,
    automatico: true,
    repos: [{ repo: 'acme/app', origem: 'marcado', runs: [] }],
    descartados: [],
    falhando: 0,
    trabalhando: 0,
    verdesSeguidos: 0,
    ...extra,
  };
}

describe('item do CI na barra de status', () => {
  it('some sem repositório acompanhado', () => {
    expect(statusBarView(undefined).visible).toBe(false);
    expect(statusBarView(status({ repos: [] })).visible).toBe(false);
  });

  it('mostra o número de fluxos falhando e avisa com a cor', () => {
    const view = statusBarView(status({ falhando: 2, trabalhando: 1, verdesSeguidos: 4 }));
    expect(view.visible).toBe(true);
    expect(view.text).toBe('$(error) 2');
    expect(view.warn).toBe(true);
    expect(view.tooltip).toContain('CI: 2 failing');
    expect(view.tooltip).toContain('1 running, 4 green in a row');
    expect(view.tooltip).toContain('acme/app');
  });

  it('sem falha mostra o visto, sem cor de aviso', () => {
    const view = statusBarView(status());
    expect(view.text).toBe('$(check) CI');
    expect(view.warn).toBe(false);
    expect(view.tooltip).toContain('CI: nothing failing');
  });

  it('diz o que falta quando a conta não está conectada ou o interruptor está desligado', () => {
    expect(statusBarView(status({ conectado: false })).tooltip).toContain('Sign in to GitHub');
    expect(statusBarView(status({ automatico: false })).tooltip).toContain('Refresh CI now');
  });
});

describe('escolha de repositórios', () => {
  it('põe os acompanhados primeiro, marcados, e não repete', () => {
    expect(repoChoices(['acme/b'], ['acme/a', 'Acme/B', 'acme/c'])).toEqual([
      { repo: 'acme/b', picked: true },
      { repo: 'acme/a', picked: false },
      { repo: 'acme/c', picked: false },
    ]);
  });

  it('respeita o máximo', () => {
    expect(repoChoices([], ['a/1', 'a/2', 'a/3'], 2)).toHaveLength(2);
  });

  it('aceita dono/nome e endereço do github.com', () => {
    expect(parseRepoInput('acme/app')).toBe('acme/app');
    expect(parseRepoInput(' https://github.com/acme/app.git ')).toBe('acme/app');
    expect(parseRepoInput('https://github.com/acme/app/')).toBe('acme/app');
    expect(parseRepoInput('acme')).toBeUndefined();
    expect(parseRepoInput('acme/app/issues')).toBeUndefined();
    expect(parseRepoInput('https://example.com/acme/app')).toBeUndefined();
  });
});
