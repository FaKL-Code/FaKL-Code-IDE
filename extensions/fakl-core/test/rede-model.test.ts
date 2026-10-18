import { describe, expect, it } from 'vitest';

import { diagnose, type DoctorItem } from '../src/doctor-model.js';
import {
  mayCheckUpdateNotice,
  mayQueryAdapterVersions,
  type NetworkSettings,
} from '../src/rede-model.js';

const padrao: NetworkSettings = { automatic: true, adapterCheck: true, updateNotify: true };
const com = (over: Partial<NetworkSettings>): NetworkSettings => ({ ...padrao, ...over });

describe('consultas automáticas à rede (ADR 0045)', () => {
  it('com tudo no padrão, as duas consultas automáticas valem', () => {
    expect(mayQueryAdapterVersions(padrao)).toBe(true);
    expect(mayCheckUpdateNotice(padrao)).toBe(true);
  });

  it('o interruptor geral desligado barra as duas', () => {
    const off = com({ automatic: false });
    expect(mayQueryAdapterVersions(off)).toBe(false);
    expect(mayCheckUpdateNotice(off)).toBe(false);
  });

  it('a verificação manual continua valendo com o interruptor desligado', () => {
    const off = com({ automatic: false, adapterCheck: false, updateNotify: false });
    expect(mayQueryAdapterVersions(off, true)).toBe(true);
    expect(mayCheckUpdateNotice(off, true)).toBe(true);
  });

  it('as configurações mais finas seguem valendo com o interruptor ligado', () => {
    expect(mayQueryAdapterVersions(com({ adapterCheck: false }))).toBe(false);
    expect(mayCheckUpdateNotice(com({ updateNotify: false }))).toBe(false);
    expect(mayCheckUpdateNotice(com({ updateMode: 'none' }))).toBe(false);
    expect(mayCheckUpdateNotice(com({ updateMode: 'start' }))).toBe(true);
  });
});

describe('Doctor: item de rede', () => {
  const find = (items: readonly DoctorItem[]): DoctorItem | undefined =>
    items.find((item) => item.id === 'rede');

  it('não aparece sem o retrato da rede', () => {
    expect(find(diagnose({ conectado: true }))).toBeUndefined();
  });

  it('ligado: informa, aponta o interruptor e o update.mode, sem pedir atenção', () => {
    const item = find(diagnose({ conectado: true, rede: { consultasAutomaticas: true } }));
    expect(item?.severidade).toBe('info');
    expect(item?.detalhe).toContain('fakl.rede.consultasAutomaticas');
    expect(item?.detalhe).toContain('update.mode');
    expect(
      item?.acoes.some((a) => a.tipo === 'link' && a.url.endsWith('docs/privacidade.md')),
    ).toBe(true);
  });

  it('desligado: oferece a conferência manual dos conectores', () => {
    const item = find(
      diagnose({
        conectado: true,
        rede: { consultasAutomaticas: false, modoAtualizacao: 'none' },
      }),
    );
    expect(item?.titulo).toMatch(/are off/);
    expect(item?.detalhe).toMatch(/none/);
    expect(
      item?.acoes.some(
        (a) => a.tipo === 'comando' && a.comando === 'fakl.rede.verificarAdaptadores',
      ),
    ).toBe(true);
  });
});
