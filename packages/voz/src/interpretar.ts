/**
 * Interpretação de um pedido falado em linguagem natural (pt-BR): decide se é
 * uma tarefa nova, uma execução avulsa (agente novo) ou uma mensagem para a
 * conversa aberta, e tira da fala os parâmetros (perfil, repositório,
 * critério, começar agora). Determinística, sem LLM: quem chama mostra o
 * resultado para confirmar antes de enviar.
 */

import { l10n } from '@fakl/i18n';

import { normalizarDitado } from './ditado.js';

/** O que o pedido vira. */
export type IntencaoDeVoz = 'tarefa' | 'avulsa' | 'mensagem';

/** Perfil de agente que a fala pode citar ("com o opus", "usa o codex"). */
export interface PerfilConhecido {
  readonly id: string;
  readonly nome: string;
  /** Modelo ou provedor, para reconhecer "sonnet", "gemini", "gpt"... */
  readonly modelo?: string;
}

/** Repositório ou pasta que a fala pode citar ("no projeto fakl code ide"). */
export interface RepoConhecido {
  readonly caminho: string;
  /** Nome curto; sem ele vale o último segmento do caminho. */
  readonly nome?: string;
}

export interface ContextoDeVoz {
  readonly perfis: readonly PerfilConhecido[];
  readonly repos: readonly RepoConhecido[];
  /** Há uma conversa aberta que pode receber a fala como mensagem. */
  readonly conversaAberta?: boolean;
  /**
   * Intenção quando a fala não indica nenhuma. Sem ela: `mensagem` com
   * conversa aberta, senão `avulsa`.
   */
  readonly padrao?: IntencaoDeVoz;
}

export interface PedidoDeVoz {
  readonly intencao: IntencaoDeVoz;
  /** O pedido em si, sem as palavras de comando, para mandar ao agente. */
  readonly texto: string;
  /** Tarefa: título curto (até 80 caracteres) tirado do pedido. */
  readonly titulo?: string;
  /** Maestro da tarefa ou perfil do agente avulso, se a fala citou um. */
  readonly perfilId?: string;
  /** Repositório ou pasta citado na fala. */
  readonly repoPath?: string;
  /** Tarefa: começar a execução logo depois de criar. Padrão: true. */
  readonly comecarAgora: boolean;
  /** Tarefa: comandos do critério de pronto ditos na fala ("critério pnpm test"). */
  readonly criterio?: readonly string[];
  /** Avulsa: trabalhar num worktree próprio, se a fala pediu. */
  readonly worktree?: boolean;
  /** Trechos da fala que viraram parâmetros, para mostrar na confirmação. */
  readonly reconhecido: readonly string[];
  /** De 0 a 1: abaixo de 0,5 a interface pede escolha explícita da intenção. */
  readonly confianca: number;
}

/** Texto em edição: o original e uma cópia sem acento nem caixa, de mesmo tamanho. */
interface Fala {
  orig: string;
  nrm: string;
}

/** Tira acento e caixa preservando o tamanho (cada unidade vira uma só), para casar índices. */
function simplificar(texto: string): string {
  let saida = '';
  for (let i = 0; i < texto.length; i += 1) {
    const ch = texto.charAt(i);
    const base = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    saida += base.length === 1 ? base : ch;
  }
  return saida;
}

function abrirFala(fala: string): Fala {
  const orig = fala.normalize('NFC');
  return { orig, nrm: simplificar(orig) };
}

function tirar(f: Fala, inicio: number, fim: number, deixarEspaco = true): void {
  const meio = deixarEspaco ? ' ' : '';
  f.orig = f.orig.slice(0, inicio) + meio + f.orig.slice(fim);
  f.nrm = f.nrm.slice(0, inicio) + meio + f.nrm.slice(fim);
}

/** Tira os espaços do começo, para os marcadores ancorados no início casarem. */
function aparar(f: Fala): void {
  const sobra = f.orig.length - f.orig.trimStart().length;
  if (sobra > 0) tirar(f, 0, sobra, false);
}

/** Tira a primeira ocorrência de `re` (aplicada ao texto simplificado). */
function tirarPrimeira(f: Fala, re: RegExp): RegExpExecArray | null {
  const m = re.exec(f.nrm);
  if (m) tirar(f, m.index, m.index + m[0].length);
  return m;
}

function ultimoSegmento(caminho: string): string {
  return (
    caminho
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? caminho
  );
}

function nomeDoRepo(repo: RepoConhecido): string {
  return repo.nome ?? ultimoSegmento(repo.caminho);
}

// --- perfil ------------------------------------------------------------

const PREP_PERFIL =
  '(?:(?:com|usando|usa|use|utilizando|via|no|na|pro|pra|para|ao|pelo|pela|em)\\s+(?:(?:o|a|os)\\s+)?(?:(?:agente|modelo|maestro|perfil|bot)\\s+)?)';

interface MencaoDePerfil {
  readonly inicio: number;
  readonly fim: number;
  readonly perfil: PerfilConhecido;
}

interface PerfisDaChave {
  readonly inteiros: PerfilConhecido[];
  readonly partes: Set<PerfilConhecido>;
}

/** Chaves faladas de cada perfil: id/nome/modelo inteiros e suas partes ("claude-opus" → "opus"). */
function chavesDosPerfis(perfis: readonly PerfilConhecido[]): Map<string, PerfisDaChave> {
  const mapa = new Map<string, PerfisDaChave>();
  const entrada = (chave: string): PerfisDaChave => {
    let e = mapa.get(chave);
    if (!e) {
      e = { inteiros: [], partes: new Set() };
      mapa.set(chave, e);
    }
    return e;
  };
  for (const perfil of perfis) {
    for (const bruto of [perfil.id, perfil.nome, perfil.modelo]) {
      if (!bruto) continue;
      const palavras = simplificar(bruto.normalize('NFC'))
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      const inteira = palavras.join(' ');
      if (inteira.length >= 3) entrada(inteira).inteiros.push(perfil);
      for (const palavra of palavras) {
        if (palavra.length >= 3 && !/^\d+$/.test(palavra)) entrada(palavra).partes.add(perfil);
      }
    }
  }
  return mapa;
}

/**
 * Acha o perfil citado. Vale a menção com preposição ("com o opus", "no codex")
 * em qualquer ponto, ou a palavra solta só no começo ou no fim da fala. Casa
 * por inteiro (primeiro perfil) ou por uma parte que só um perfil tem; parte
 * ambígua ("claude" com vários perfis claude-*) não define perfil.
 */
function acharPerfil(nrm: string, perfis: readonly PerfilConhecido[]): MencaoDePerfil | undefined {
  interface Candidata {
    inicio: number;
    fim: number;
    comPrep: boolean;
    perfis: PerfisDaChave;
  }
  const candidatas: Candidata[] = [];
  for (const [chave, alvo] of chavesDosPerfis(perfis)) {
    const corpo = chave.split(' ').join('[\\s\\-_.]*');
    const re = new RegExp(`(?<![a-z0-9])(${PREP_PERFIL})?${corpo}(?![a-z0-9])`, 'g');
    for (const m of nrm.matchAll(re)) {
      candidatas.push({
        inicio: m.index,
        fim: m.index + m[0].length,
        comPrep: m[1] !== undefined,
        perfis: alvo,
      });
    }
  }
  const primeiroUtil = nrm.search(/[^\s,:;.!-]/);
  const ordem = (a: Candidata, b: Candidata): number => a.inicio - b.inicio || b.fim - a.fim;
  const escolhida =
    candidatas.filter((c) => c.comPrep).sort(ordem)[0] ??
    candidatas
      .filter((c) => c.inicio === primeiroUtil || /^[\s.,;:!?]*$/.test(nrm.slice(c.fim)))
      .sort(ordem)[0];
  if (!escolhida) return undefined;
  const { inteiros, partes } = escolhida.perfis;
  const perfil = inteiros[0] ?? (partes.size === 1 ? [...partes][0] : undefined);
  return perfil ? { inicio: escolhida.inicio, fim: escolhida.fim, perfil } : undefined;
}

// --- repositório -------------------------------------------------------

const PREP_REPO_FORTE =
  '(?:(?:no|na|em|do|da|pro|pra|para|ao)\\s+(?:(?:o|a)\\s+)?(?:projeto|repositorio|repo|pasta|diretorio|codigo)\\s+(?:(?:chamado|chamada)\\s+)?)';
const PREP_REPO_FRACA = '(?:(?:em|no|na)\\s+(?:(?:o|a)\\s+)?)';

interface MencaoDeRepo {
  readonly inicio: number;
  readonly fim: number;
  readonly repo: RepoConhecido;
}

/**
 * Acha o repositório citado ("no projeto X", "na pasta X", ou só "em X"),
 * tolerando separadores: "fakl code ide" casa com "fakl-code-ide". Prefere a
 * forma com "projeto/pasta..." e, dentro dela, o nome mais longo.
 */
function acharRepo(nrm: string, repos: readonly RepoConhecido[]): MencaoDeRepo | undefined {
  const forte: MencaoDeRepo[] = [];
  const fraca: MencaoDeRepo[] = [];
  for (const repo of repos) {
    for (const nome of [repo.nome, ultimoSegmento(repo.caminho)]) {
      const compacto = simplificar((nome ?? '').normalize('NFC')).replace(/[^a-z0-9]/g, '');
      if (compacto.length < 2) continue;
      const corpo = Array.from(compacto).join('[\\s\\-_.]*');
      const formas = [
        [PREP_REPO_FORTE, forte],
        [PREP_REPO_FRACA, fraca],
      ] as const;
      for (const [prep, destino] of formas) {
        const m = new RegExp(`(?<![a-z0-9])${prep}${corpo}(?![a-z0-9])`).exec(nrm);
        if (m) destino.push({ inicio: m.index, fim: m.index + m[0].length, repo });
      }
    }
  }
  const maisLonga = (a: MencaoDeRepo, b: MencaoDeRepo): number =>
    b.fim - b.inicio - (a.fim - a.inicio);
  return forte.sort(maisLonga)[0] ?? fraca.sort(maisLonga)[0];
}

// --- marcadores de intenção --------------------------------------------

const SEP = '[\\s:,;.-]*';
const ART = '(?:uma?\\s+|a\\s+|essa\\s+|esta\\s+)?';
const VERBOS_ABRIR = 'cria|crie|criar|abre|abra|abrir|inicia|inicie|iniciar|comeca|comece|comecar';

interface Marcador {
  readonly intencao: IntencaoDeVoz;
  readonly re: RegExp;
  /** Só vale se um perfil conhecido vier logo depois ("pergunta pro opus ..."). */
  readonly exigePerfil?: true;
}

const MARCADORES: readonly Marcador[] = [
  {
    intencao: 'tarefa',
    re: new RegExp(
      `^(?:(?:eu\\s+)?(?:quero|queria|preciso|gostaria)\\s+(?:de\\s+)?(?:que\\s+(?:voce\\s+)?)?)?(?:(?:${VERBOS_ABRIR}|adiciona|adicione|adicionar|registra|registre|registrar|anota|anote|anotar|faz|faca|fazer)\\s+)?${ART}(?:nova\\s+)?tarefa\\b${SEP}`,
    ),
  },
  {
    intencao: 'tarefa',
    re: new RegExp(
      `^(?:manda|mande|mandar|chama|chame|chamar|aciona|acione|acionar|pede|peca|pedir|pergunta|pergunte)\\s+(?:o|pro|pra|para\\s+o|para|ao)\\s+maestro\\b(?:\\s+(?:a\\s+)?fazer\\b)?${SEP}`,
    ),
  },
  { intencao: 'tarefa', re: new RegExp(`^(?:orquestra|orquestre|orquestrar)\\b${SEP}`) },
  {
    intencao: 'avulsa',
    re: new RegExp(
      `^(?:(?:faz|faca|fazer|${VERBOS_ABRIR}|roda|rode|rodar|executa|execute|executar|quero|preciso)\\s+)*${ART}(?:execucao\\s+avulsa|novo\\s+agente|agente\\s+novo|nova\\s+execucao|nova\\s+conversa)\\b${SEP}`,
    ),
  },
  {
    intencao: 'avulsa',
    re: new RegExp(
      `^(?:${VERBOS_ABRIR}|puxa|puxe)\\s+${ART}(?:nova\\s+)?conversa(?:\\s+nova)?\\b${SEP}`,
    ),
  },
  {
    intencao: 'avulsa',
    re: new RegExp(
      `^(?:roda|rode|rodar|executa|execute|executar|chama|chame|chamar|lanca|lance|lancar|abre|abra|abrir|inicia|inicie|iniciar|sobe|suba)\\s+(?:um|o|esse)\\s+agente\\b${SEP}`,
    ),
  },
  {
    intencao: 'avulsa',
    re: /^(?:pergunta|pergunte|perguntar|pede|peca|pedir)\s+(?:pro|pra|para\s+o|para\s+a|para|ao|a)\s+/,
    exigePerfil: true,
  },
  {
    intencao: 'mensagem',
    re: new RegExp(
      `^(?:responde|responda|responder|manda|mande|mandar|diz|diga|dizer|fala|fale|falar|envia|envie|enviar|escreve|escreva|escrever|avisa|avise)\\s+(?:(?:isso|uma\\s+mensagem|mensagem|la)\\s+)?(?:pra|para|pro|na|no|ao|a)\\s+(?:(?:a|o)\\s+)?(?:conversa|agente|ia|ai|chat)(?:\\s+(?:atual|aberta|ai|ali))?\\b(?:\\s+que\\b)?${SEP}`,
    ),
  },
  { intencao: 'mensagem', re: new RegExp(`^(?:responde|responda|responder)\\b${SEP}`) },
  {
    intencao: 'mensagem',
    re: new RegExp(
      `^(?:na|nessa|nesta|pra|para|a)\\s+(?:a\\s+)?conversa\\s+(?:atual|aberta|corrente)\\b${SEP}`,
    ),
  },
];

const RE_INTERJEICAO =
  /^[\s,:;.!-]*(?:(?:oi|ola|ei|ok|entao|bom|agora|por\s+favor|tipo)\b[\s,:;.!-]*)*/;
const RE_SO_CRIA = /^so\s+(?=(?:cria|crie|criar)\b)/;
const RE_EXECUCAO_AVULSA = /\bexecucao\s+avulsa\b[\s:,;.-]*/;

// --- parâmetros --------------------------------------------------------

const RE_NAO_COMECAR =
  /(?:[,;]\s*)?(?:\be\s+)?\b(?:nao\s+(?:comeca|comece|comecar|inicia|inicie|iniciar)\b(?:\s+(?:ainda|agora)\b|(?=\s*(?:[,.;!]|$)))|sem\s+(?:comecar|iniciar|executar)\b|(?:deixa|deixe)\s+(?:pra|para)\s+depois\b)/;
const RE_COMECAR_AGORA =
  /(?:[,;]\s*)?(?:\be\s+)?\b(?:ja\s+)?(?:comeca|comece|comecar|inicia|inicie|iniciar)\s+(?:agora|ja|logo|imediatamente)\b(?=\s*(?:[,.;!]|$))/;
const RE_SEM_WORKTREE =
  /\b(?:sem\s+worktree|na\s+pasta\s+mesmo|na\s+propria\s+pasta|sem\s+isolamento|sem\s+isolar)\b/;
const RE_COM_WORKTREE =
  /\b(?:(?:num|numa|em|no|com|usando|use|usa)\s+(?:(?:um|uma|novo|nova)\s+)*worktree(?:\s+(?:proprio|novo|isolado))?|isolad[oa])\b/;

const COMANDO =
  '(?:pnpm|npm|yarn|npx|bun|deno|make|cargo|go|dotnet|pytest|python|vitest|jest|tsc|eslint|prettier|mvn|gradle|git|docker|bash|sh)';
const CRITERIO = '(?:(?:com|e|tendo)\\s+(?:o\\s+)?)?\\bcriterios?\\b';
const DE_PRONTO = '\\s+de\\s+(?:pronto|aceite|aceitacao|conclusao)';
const CAUDA = '((?:[^.!?\\n]|\\.(?!\\s|$))*)';
/** "critério: ...", "critério de pronto ..." e "critério pnpm ..." (só com comando conhecido). */
const RES_CRITERIO: readonly RegExp[] = [
  new RegExp(`${CRITERIO}(?:${DE_PRONTO})?\\s*:\\s*${CAUDA}`),
  new RegExp(`${CRITERIO}${DE_PRONTO}(?:\\s+(?:e|eh|sao|seria|serao)\\b)?[\\s,-]*${CAUDA}`),
  new RegExp(`${CRITERIO}(?:\\s+(?:e|eh|sao|seria|serao)\\b)?[\\s,-]*(?=${COMANDO}\\b)${CAUDA}`),
];

/** Tira "critério <comandos>" até o fim da frase e devolve os comandos. */
function tirarCriterio(f: Fala): string[] | undefined {
  for (const re of RES_CRITERIO) {
    const m = re.exec(f.nrm);
    if (!m) continue;
    const fim = m.index + m[0].length;
    const comandos = f.orig
      .slice(fim - (m[1] ?? '').length, fim)
      .split(/\s*(?:;|,|\s+e\s+)\s*/i)
      .map((c) => c.replace(/^["“”']+|["“”'.]+$/g, '').trim())
      .filter(Boolean);
    if (comandos.length === 0) continue;
    tirar(f, m.index, fim);
    return comandos;
  }
  return undefined;
}

/** Deixa o pedido legível: sem conectivos soltos nas pontas e já com o ditado aplicado. */
function limpar(texto: string): string {
  const limpo = texto
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s,;:.!-]+/, '')
    .replace(/^(?:(?:pra|para|que|de|e)(?![\p{L}\p{N}])[\s,;:-]*)+/iu, '')
    .replace(/[\s,;:-]+\.?$/, '')
    .replace(/\s+(?:e|com|usando)$/i, '');
  return normalizarDitado(limpo);
}

const LIMITE_TITULO = 80;

/** Primeira frase do pedido, cortada em palavra até 80 caracteres. */
function tituloDe(texto: string): string | undefined {
  const frase = (texto.split(/(?<=[.!?])\s|\n/)[0] ?? '').replace(/[.!?]+$/, '').trim();
  if (frase === '') return undefined;
  if (frase.length <= LIMITE_TITULO) return frase;
  const corte = frase.slice(0, LIMITE_TITULO + 1);
  const espaco = corte.lastIndexOf(' ');
  const base = espaco > LIMITE_TITULO / 2 ? corte.slice(0, espaco) : corte.slice(0, LIMITE_TITULO);
  return base.replace(/[\s,;:-]+$/, '');
}

function rotuloDaIntencao(intencao: IntencaoDeVoz): string {
  switch (intencao) {
    case 'tarefa':
      return l10n.t('task');
    case 'avulsa':
      return l10n.t('standalone run');
    case 'mensagem':
      return l10n.t('message');
  }
}

/**
 * Lê o pedido falado. Casa em texto sem acento nem caixa, mas devolve o que
 * a pessoa disse. Sem marcador claro ("cria uma tarefa", "pergunta pro opus",
 * "responde...") a intenção vem de `contexto.padrao` e a confiança fica baixa.
 */
export function interpretar(fala: string, contexto: ContextoDeVoz): PedidoDeVoz {
  const f = abrirFala(fala);
  let naoComecar = false;

  tirarPrimeira(f, RE_INTERJEICAO);
  aparar(f);
  if (tirarPrimeira(f, RE_SO_CRIA)) naoComecar = true;
  aparar(f);

  let intencao: IntencaoDeVoz | undefined;
  let confianca = 0.9;
  for (const marcador of MARCADORES) {
    const m = marcador.re.exec(f.nrm);
    if (!m) continue;
    if (marcador.exigePerfil) {
      const resto = f.nrm.slice(m[0].length);
      const citado = acharPerfil(resto, contexto.perfis);
      if (!citado || resto.slice(0, citado.inicio).trim() !== '') continue;
    }
    tirar(f, 0, m[0].length);
    intencao = marcador.intencao;
    break;
  }
  if (!intencao && tirarPrimeira(f, RE_EXECUCAO_AVULSA)) {
    intencao = 'avulsa';
    confianca = 0.85;
  }
  const marcado = intencao !== undefined;
  if (!intencao) {
    intencao = contexto.padrao ?? (contexto.conversaAberta ? 'mensagem' : 'avulsa');
    confianca = 0.4;
  }

  let worktree: boolean | undefined;
  if (intencao !== 'mensagem') {
    if (tirarPrimeira(f, RE_SEM_WORKTREE)) worktree = false;
    else if (tirarPrimeira(f, RE_COM_WORKTREE)) worktree = true;
  }
  if (intencao === 'tarefa') {
    if (tirarPrimeira(f, RE_NAO_COMECAR)) naoComecar = true;
    else tirarPrimeira(f, RE_COMECAR_AGORA);
  }

  let repo: RepoConhecido | undefined;
  let perfil: PerfilConhecido | undefined;
  let criterio: string[] | undefined;
  if (intencao !== 'mensagem') {
    const doRepo = acharRepo(f.nrm, contexto.repos);
    if (doRepo) {
      repo = doRepo.repo;
      tirar(f, doRepo.inicio, doRepo.fim);
    }
    const doPerfil = acharPerfil(f.nrm, contexto.perfis);
    if (doPerfil) {
      perfil = doPerfil.perfil;
      tirar(f, doPerfil.inicio, doPerfil.fim);
    }
  }
  if (intencao === 'tarefa') criterio = tirarCriterio(f);

  const texto = limpar(f.orig);
  const titulo = intencao === 'tarefa' ? tituloDe(texto) : undefined;

  const reconhecido: string[] = [];
  if (marcado) reconhecido.push(rotuloDaIntencao(intencao));
  if (perfil) reconhecido.push(l10n.t('profile: {0}', perfil.nome));
  if (repo) reconhecido.push(l10n.t('repository: {0}', nomeDoRepo(repo)));
  if (criterio) reconhecido.push(l10n.t('criteria: {0}', criterio.join(', ')));
  if (naoComecar) reconhecido.push(l10n.t('do not start now'));
  if (worktree !== undefined) reconhecido.push(worktree ? 'worktree' : l10n.t('no worktree'));

  return {
    intencao,
    texto,
    ...(titulo !== undefined && { titulo }),
    ...(perfil && { perfilId: perfil.id }),
    ...(repo && { repoPath: repo.caminho }),
    comecarAgora: !naoComecar,
    ...(criterio && { criterio }),
    ...(worktree !== undefined && { worktree }),
    reconhecido,
    confianca,
  };
}

const LIMITE_DESCRICAO = 120;

function entreAspas(texto: string): string {
  const curto =
    texto.length > LIMITE_DESCRICAO ? `${texto.slice(0, LIMITE_DESCRICAO - 1).trimEnd()}…` : texto;
  return `“${curto}”`;
}

/** Uma linha em pt-BR que descreve o pedido, para o cartão de confirmação. */
export function descreverPedido(pedido: PedidoDeVoz, contexto: ContextoDeVoz): string {
  const perfilNome = contexto.perfis.find((p) => p.id === pedido.perfilId)?.nome ?? pedido.perfilId;
  const repo = contexto.repos.find((r) => r.caminho === pedido.repoPath);
  const repoNome = repo ? nomeDoRepo(repo) : pedido.repoPath;

  if (pedido.intencao === 'mensagem') {
    return l10n.t('Send to the open conversation: {0}', entreAspas(pedido.texto));
  }
  if (pedido.intencao === 'tarefa') {
    let linha = l10n.t('Create the task');
    if (pedido.titulo) linha += ` ${entreAspas(pedido.titulo)}`;
    if (repoNome) linha += l10n.t(' in {0}', repoNome);
    if (perfilNome) linha += l10n.t(' with the maestro {0}', perfilNome);
    if (pedido.criterio?.length) linha += l10n.t(' (criteria: {0})', pedido.criterio.join('; '));
    return `${linha} ${pedido.comecarAgora ? l10n.t('and start now') : l10n.t('without starting now')}`;
  }
  let linha = l10n.t('Open a new conversation');
  if (perfilNome) linha += l10n.t(' with {0}', perfilNome);
  if (repoNome) linha += l10n.t(' in {0}', repoNome);
  if (pedido.worktree) linha += l10n.t(' in its own worktree');
  return pedido.texto ? `${linha}: ${entreAspas(pedido.texto)}` : linha;
}
