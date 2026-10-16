import { montarJuntos } from '../h/gancho';
import { langDoDocumento, textos } from '../../i18n';
import type { Montar } from '../util';

/** 0–6,3 s no 9:16. A palavra muda com o idioma (JUN/TOS. e TOGE/THER.). */
export const ganchoV: Montar = (root) => {
  const en = langDoDocumento() === 'en';
  return montarJuntos(root, '#v1-juntos', {
    lado: en ? 36 : 44,
    x: en ? 90 : 122,
    y: en ? 284 : 220,
    linhas: textos(langDoDocumento()).cena.abertura.v,
  });
};
