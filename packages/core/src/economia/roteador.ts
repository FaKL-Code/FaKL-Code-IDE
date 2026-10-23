/**
 * Roteamento por camadas (ADR 0052): tarefa simples vai ao perfil barato,
 * tarefa difícil ao forte, e o placar de agentes (ADR 0043) desempata e
 * impede mandar trabalho a quem vem sendo reprovado. A classificação é uma
 * heurística local, sem chamar modelo: custa zero token e é previsível.
 */

export type Complexidade = 'baixa' | 'media' | 'alta';

export interface Classificacao {
  readonly nivel: Complexidade;
  readonly sinais: readonly string[];
}

const SINAIS_ALTOS: readonly [RegExp, string][] = [
  [/arquitetur|architect|redesign|reescrev|rewrite/i, 'arquitetura'],
  [
    /seguran[cç]a|security|vulnerab|criptograf|crypto|autentica|authent|oauth|permiss/i,
    'segurança',
  ],
  [/migra[cç]|migrat|schema|banco de dados|database/i, 'migração ou dados'],
  [/concorr[eê]n|race condition|deadlock|thread|assíncron|asynchron/i, 'concorrência'],
  [/desempenho|performance|otimiz|optimi[sz]/i, 'desempenho'],
  [
    /refator|refactor|v[aá]rios arquivos|many files|multiple files|todo o projeto/i,
    'refatoração ampla',
  ],
  [/investig|debug|causa raiz|root cause|n[aã]o reproduz|intermitente|flaky/i, 'investigação'],
];

const SINAIS_BAIXOS: readonly [RegExp, string][] = [
  [/typo|erro de digita|ortografia/i, 'texto'],
  [/renomei|rename/i, 'renomear'],
  [/coment[aá]rio|comment|docstring|readme|changelog|documenta[cç]/i, 'documentação'],
  [/formata|format|lint|indenta|prettier/i, 'formatação'],
  [/bump|vers[aã]o d[ao]|atualiz\w+ a depend/i, 'versão'],
  [/uma linha|one line|trivial|simples|simple|pequen/i, 'pedido simples'],
];

const LONGO = 1_500;
const CURTO = 400;

export function classificarComplexidade(
  instrucoes: string,
  opcoes: { criterio?: string; papel?: string } = {},
): Classificacao {
  const texto = `${instrucoes}\n${opcoes.criterio ?? ''}`;
  const sinais: string[] = [];
  let pontos = 0;
  for (const [regex, nome] of SINAIS_ALTOS) {
    if (regex.test(texto)) {
      pontos += 2;
      sinais.push(nome);
    }
  }
  for (const [regex, nome] of SINAIS_BAIXOS) {
    if (regex.test(texto)) {
      pontos -= 2;
      sinais.push(nome);
    }
  }
  if (texto.length > LONGO) {
    pontos += 1;
    sinais.push('instruções longas');
  } else if (texto.length < CURTO) {
    pontos -= 1;
  }
  // Revisar costuma pedir mais critério do que escrever o mesmo trecho.
  if (opcoes.papel === 'revisor') pontos += 1;
  // Um sub-maestro coordena outros agentes: não vai ao perfil mais fraco.
  if (opcoes.papel === 'maestro') pontos += 3;
  const nivel: Complexidade = pontos >= 2 ? 'alta' : pontos <= -2 ? 'baixa' : 'media';
  return { nivel, sinais };
}

/**
 * Nível de uma parte delegada: quem delega já planejou e quebrou o trabalho, e a
 * revisão e as verificações conferem o resultado, então a execução cabe um nível
 * abaixo do que o texto sozinho indicaria.
 */
export function nivelDelegado(nivel: Complexidade): Complexidade {
  return nivel === 'alta' ? 'media' : 'baixa';
}

export interface PerfilRoteavel {
  readonly id: string;
  readonly custoRelativo: 'baixo' | 'médio' | 'alto';
  readonly instalado: boolean;
  readonly bloqueado: boolean;
  readonly podeSerMaestro: boolean;
  readonly taxaAprovacao?: number;
}

export interface Escolha {
  readonly id: string;
  readonly nivel: Complexidade;
  readonly custo: 'baixo' | 'médio' | 'alto';
  readonly motivo: string;
}

/** Ordem de tentativa de cada nível: a camada certa primeiro, depois as vizinhas. */
const ORDEM: Record<Complexidade, readonly ('baixo' | 'médio' | 'alto')[]> = {
  baixa: ['baixo', 'médio', 'alto'],
  media: ['médio', 'baixo', 'alto'],
  alta: ['alto', 'médio', 'baixo'],
};

/** Abaixo disso, com amostra suficiente, o perfil não recebe trabalho novo se houver alternativa. */
const APROVACAO_MIN = 0.6;

export function escolherPerfil(
  perfis: readonly PerfilRoteavel[],
  nivel: Complexidade,
  opcoes: { papel?: string } = {},
): Escolha | undefined {
  const usaveis = perfis.filter(
    (p) => p.instalado && !p.bloqueado && (opcoes.papel !== 'maestro' || p.podeSerMaestro),
  );
  for (const custo of ORDEM[nivel]) {
    const daCamada = usaveis.filter((p) => p.custoRelativo === custo);
    if (daCamada.length === 0) continue;
    // Quem está sendo reprovado só entra se não houver outro na camada.
    const aprovados = daCamada.filter(
      (p) => p.taxaAprovacao === undefined || p.taxaAprovacao >= APROVACAO_MIN,
    );
    const pool = aprovados.length > 0 ? aprovados : daCamada;
    const melhor = [...pool].sort(
      (a, b) => (b.taxaAprovacao ?? -1) - (a.taxaAprovacao ?? -1) || a.id.localeCompare(b.id),
    )[0];
    if (!melhor) continue;
    const exato = custo === ORDEM[nivel][0];
    return {
      id: melhor.id,
      nivel,
      custo,
      motivo: `tarefa ${nivel}: camada de custo ${custo}${exato ? '' : ' (a camada ideal não tem perfil disponível)'}${
        melhor.taxaAprovacao !== undefined
          ? `, aprovação ${String(Math.round(melhor.taxaAprovacao * 100))}% no placar`
          : ''
      }`,
    };
  }
  return undefined;
}

const PESO: Record<'baixo' | 'médio' | 'alto', number> = { baixo: 0, médio: 1, alto: 2 };

/** A escolha ficou mais barata do que o perfil de quem pediu? */
export function rebaixou(escolha: Escolha, custoDeQuemPediu: 'baixo' | 'médio' | 'alto'): boolean {
  return PESO[escolha.custo] < PESO[custoDeQuemPediu];
}
