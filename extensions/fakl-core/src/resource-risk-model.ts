import { l10n } from '@fakl/i18n';
import type { ResourceRisk, ResourceRiskSeverity, ResourceSource } from '@fakl/protocol';

/**
 * Textos e decisões da varredura de recursos na interface (ADR 0042). A
 * varredura é heurística: o texto sempre diz "achados", nunca "seguro".
 */

const SEVERITY_ORDER: Record<ResourceRiskSeverity, number> = { alta: 0, media: 1, baixa: 2 };
const TOOLTIP_FINDINGS = 6;
const MODAL_FINDINGS_PER_ITEM = 5;
const MODAL_ITEMS = 8;
const SNIPPET_MAX = 80;

export type RiskItemKind = 'agent' | 'skill' | 'mcp';

/** Um item que o usuário escolheu instalar e tem achados. */
export interface RiskyItem {
  readonly kind: RiskItemKind;
  readonly name: string;
  /** Id da fonte que oferece o item. */
  readonly fonte: string;
  readonly riscos: readonly ResourceRisk[];
}

/** Descrição de cada regra, no idioma da interface; regra desconhecida mostra o id. */
export function riskRuleLabel(regra: string): string {
  switch (regra) {
    case 'prompt-injection':
      return l10n.t("Text that tries to override the agent's instructions");
    case 'unicode-invisivel':
      return l10n.t('Invisible or direction-changing characters');
    case 'base64-longo':
      return l10n.t('Long encoded (base64) block');
    case 'baixa-e-executa':
      return l10n.t('Downloads and runs code in one step');
    case 'executa-texto':
      return l10n.t('Runs text as code (eval, Invoke-Expression)');
    case 'envio-externo':
      return l10n.t('Mentions an external address that receives data');
    case 'le-segredos':
      return l10n.t('Mentions secrets (.env, SSH keys, cloud credentials)');
    case 'sem-confirmacao':
      return l10n.t('Turns off permission or confirmation prompts');
    case 'mcp-shell':
      return l10n.t('MCP server that starts a shell');
    case 'mcp-sem-versao':
      return l10n.t('MCP server run without a pinned version');
    case 'mcp-dominio-estranho':
      return l10n.t('MCP server at an unusual address (tunnel, IP or plain http)');
    default:
      return regra;
  }
}

export function riskSeverityLabel(severidade: ResourceRiskSeverity): string {
  switch (severidade) {
    case 'alta':
      return l10n.t('high');
    case 'media':
      return l10n.t('medium');
    case 'baixa':
      return l10n.t('low');
  }
}

function sorted(riscos: readonly ResourceRisk[]): ResourceRisk[] {
  return [...riscos].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severidade] - SEVERITY_ORDER[b.severidade] ||
      a.arquivo.localeCompare(b.arquivo) ||
      a.linha - b.linha,
  );
}

/** Pior severidade da lista, ou `undefined` sem achados. */
export function worstRisk(riscos: readonly ResourceRisk[]): ResourceRiskSeverity | undefined {
  return sorted(riscos)[0]?.severidade;
}

/** Alta ou média pedem confirmação antes de instalar; baixa só aparece no tooltip. */
export function needsConfirmation(riscos: readonly ResourceRisk[]): boolean {
  const worst = worstRisk(riscos);
  return worst === 'alta' || worst === 'media';
}

/** "2 high, 1 low"; vazio sem achados. */
export function riskSummary(riscos: readonly ResourceRisk[]): string {
  const count = (severidade: ResourceRiskSeverity): number =>
    riscos.filter((risk) => risk.severidade === severidade).length;
  return [
    count('alta') > 0 ? l10n.t('{0} high', count('alta')) : '',
    count('media') > 0 ? l10n.t('{0} medium', count('media')) : '',
    count('baixa') > 0 ? l10n.t('{0} low', count('baixa')) : '',
  ]
    .filter(Boolean)
    .join(', ');
}

function snippet(text: string): string {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : text;
}

function findingLine(risk: ResourceRisk): string {
  return `- ${riskRuleLabel(risk.regra)} [${riskSeverityLabel(risk.severidade)}] ${risk.arquivo}:${risk.linha}: ${snippet(risk.trecho)}`;
}

/** Texto do tooltip do item: resumo, achados principais e o que a varredura não é. */
export function riskTooltip(riscos: readonly ResourceRisk[]): string {
  const list = sorted(riscos);
  const lines = [
    l10n.t('Static scan findings: {0}.', riskSummary(riscos)),
    ...list.slice(0, TOOLTIP_FINDINGS).map(findingLine),
  ];
  if (list.length > TOOLTIP_FINDINGS) {
    lines.push(l10n.t('…and {0} more.', list.length - TOOLTIP_FINDINGS));
  }
  lines.push(
    l10n.t('A finding is a hint, not proof of bad intent; read the item before installing.'),
  );
  return lines.join('\n');
}

function kindLabel(kind: RiskItemKind): string {
  switch (kind) {
    case 'agent':
      return l10n.t('Agent');
    case 'skill':
      return l10n.t('Skill');
    case 'mcp':
      return l10n.t('MCP server');
  }
}

/** De onde vem a fonte: URL do repositório ou pasta local, com o nome. */
export function sourceOrigin(
  fonte: string,
  sources: readonly Pick<ResourceSource, 'id' | 'nome' | 'url' | 'caminho'>[],
): string {
  const source = sources.find((candidate) => candidate.id === fonte);
  if (!source) return l10n.t('Source {0}', fonte);
  return l10n.t('Source {0} ({1})', source.nome, source.url ?? source.caminho);
}

/**
 * Confirmação modal para itens com achado de severidade alta ou média: lista
 * os achados e a origem. `undefined` quando nenhum item precisa de confirmação.
 */
export function riskConfirmation(
  items: readonly RiskyItem[],
  sources: readonly Pick<ResourceSource, 'id' | 'nome' | 'url' | 'caminho'>[],
): { message: string; detail: string } | undefined {
  const flagged = items.filter((item) => needsConfirmation(item.riscos));
  if (flagged.length === 0) return undefined;
  const blocks = flagged.slice(0, MODAL_ITEMS).map((item) => {
    const list = sorted(item.riscos);
    const lines = [
      `${kindLabel(item.kind)} ${item.name}`,
      sourceOrigin(item.fonte, sources),
      ...list.slice(0, MODAL_FINDINGS_PER_ITEM).map(findingLine),
    ];
    if (list.length > MODAL_FINDINGS_PER_ITEM) {
      lines.push(l10n.t('…and {0} more.', list.length - MODAL_FINDINGS_PER_ITEM));
    }
    return lines.join('\n');
  });
  if (flagged.length > MODAL_ITEMS) {
    blocks.push(l10n.t('…and {0} more items with findings.', flagged.length - MODAL_ITEMS));
  }
  const message =
    flagged.length === 1 && flagged[0]
      ? l10n.t('The static scan found risks in {0}. Install anyway?', flagged[0].name)
      : l10n.t(
          'The static scan found risks in {0} of the chosen items. Install anyway?',
          flagged.length,
        );
  const footer = l10n.t(
    'The scan is a heuristic: it can be wrong in both directions. Cancel installs nothing from this selection.',
  );
  return { message, detail: `${blocks.join('\n\n')}\n\n${footer}` };
}
