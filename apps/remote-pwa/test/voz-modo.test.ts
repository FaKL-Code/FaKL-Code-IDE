import { useLocale } from '@fakl/i18n';
import { afterEach, describe, expect, it } from 'vitest';

import { escolherModoDeVoz } from '../src/voz-modo.js';

const TUDO = { navegador: true, gravacao: true };
const SO_GRAVA = { navegador: false, gravacao: true };
const NADA = { navegador: false, gravacao: false };

describe('escolherModoDeVoz', () => {
  afterEach(() => useLocale('en'));

  it('sem modo escolhido na IDE, o microfone fica desligado', () => {
    const { modo, dica } = escolherModoDeVoz(TUDO, { configurado: false, motivo: 'voz desligada' });
    expect(modo).toBeUndefined();
    expect(dica).toMatch(/off.*Configure voice/);
  });

  it('modo navegador usa a Web Speech API, mesmo quando também daria para gravar', () => {
    expect(escolherModoDeVoz(TUDO, { configurado: true, modo: 'navegador' })).toEqual({
      modo: 'navegador',
    });
    expect(escolherModoDeVoz(SO_GRAVA, { configurado: true, modo: 'navegador' }).dica).toMatch(
      /doesn't recognize speech/,
    );
  });

  it('modos do Core gravam e não mandam a fala ao navegador', () => {
    const status = { configurado: true, modo: 'local', provedor: 'local' } as const;
    expect(escolherModoDeVoz(TUDO, status)).toEqual({ modo: 'gravacao' });
    expect(escolherModoDeVoz(NADA, status).dica).toMatch(/doesn't record/);
    // Core antigo, sem modo no status.
    expect(escolherModoDeVoz(TUDO, { configurado: true, provedor: 'openai' })).toEqual({
      modo: 'gravacao',
    });
  });

  it('modo escolhido mas incompleto, ou IDE sem resposta, explica o motivo', () => {
    expect(
      escolherModoDeVoz(TUDO, { configurado: false, modo: 'openai', motivo: 'falta a chave' }).dica,
    ).toMatch(/isn't ready.*falta a chave/);
    expect(escolherModoDeVoz(TUDO, undefined).dica).toMatch(/No response/);
  });

  it('explica em pt-BR quando o idioma é pt-BR', () => {
    useLocale('pt-br');
    expect(escolherModoDeVoz(TUDO, undefined).dica).toBe(
      'Sem resposta da IDE. Use o ditado do teclado do celular.',
    );
    expect(
      escolherModoDeVoz(TUDO, { configurado: false, modo: 'openai', motivo: 'falta a chave' }).dica,
    ).toBe('A voz não está pronta na IDE (falta a chave). Use o ditado do teclado do celular.');
  });
});
