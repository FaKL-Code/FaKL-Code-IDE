/**
 * A página do Doctor como texto HTML. Pura (sem VS Code) para ser testada: o
 * host só entrega o nonce da CSP e o idioma. A página não decide nada: cada
 * botão devolve o id do item e o índice da ação, e o host só roda o que
 * ofereceu.
 */

import { l10n } from '@fakl/i18n';

import { doctorSummary, type DoctorItem, type DoctorSeverity } from './doctor-model.js';

export interface DoctorViewOptions {
  readonly nonce: string;
  readonly cspSource: string;
  readonly language: string;
  /** A leitura da máquina ainda está em andamento. */
  readonly loading: boolean;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function severityLabel(severity: DoctorSeverity): string {
  switch (severity) {
    case 'ok':
      return l10n.t('OK');
    case 'info':
      return l10n.t('Note');
    case 'aviso':
      return l10n.t('Check');
    case 'problema':
      return l10n.t('Fix this');
  }
}

function headline(items: readonly DoctorItem[]): string {
  const { problemas, avisos } = doctorSummary(items);
  if (problemas === 0 && avisos === 0) return l10n.t('Everything agents need is in place.');
  const parts = [
    problemas > 0
      ? problemas === 1
        ? l10n.t('1 thing to fix')
        : l10n.t('{0} things to fix', problemas)
      : '',
    avisos > 0 ? (avisos === 1 ? l10n.t('1 to check') : l10n.t('{0} to check', avisos)) : '',
  ].filter(Boolean);
  return parts.join(', ');
}

const STYLE = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 24px; max-width: 760px; }
h1 { font-size: 1.5em; margin: 0 0 4px; }
.lede { margin: 0 0 16px; opacity: 0.8; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.item { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-left-width: 4px; border-radius: 4px; padding: 10px 12px; margin-bottom: 8px; }
.item.ok { border-left-color: var(--vscode-testing-iconPassed, #3fb950); }
.item.info { border-left-color: var(--vscode-descriptionForeground, #888); }
.item.aviso { border-left-color: var(--vscode-editorWarning-foreground, #d29922); }
.item.problema { border-left-color: var(--vscode-editorError-foreground, #f85149); }
.tag { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
.title { font-weight: 600; margin: 2px 0; }
.detail { margin: 0 0 6px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
button { cursor: pointer; padding: 4px 12px; border-radius: 2px; border: 1px solid transparent; font: inherit; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:hover { filter: brightness(1.1); }
code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
`;

function itemHtml(item: DoctorItem): string {
  const actions = item.acoes
    .map((action, index) => {
      const hint =
        action.tipo === 'terminal'
          ? ` title="${escapeHtml(l10n.t('Types {0} in a terminal; you press Enter to run it', action.texto))}"`
          : '';
      return `<button type="button" class="${index === 0 ? 'primary' : ''}" data-item="${escapeHtml(item.id)}" data-indice="${index}"${hint}>${escapeHtml(action.rotulo)}</button>`;
    })
    .join('');
  const commands = item.acoes
    .flatMap((action) => (action.tipo === 'terminal' ? [action.texto] : []))
    .map((texto) => `<code>${escapeHtml(texto)}</code>`)
    .join(' ');
  return `<section class="item ${item.severidade}" aria-label="${escapeHtml(item.titulo)}">
<span class="tag">${escapeHtml(severityLabel(item.severidade))}</span>
<div class="title">${escapeHtml(item.titulo)}</div>
<p class="detail">${escapeHtml(item.detalhe)}${commands ? ` ${commands}` : ''}</p>
${actions ? `<div class="actions">${actions}</div>` : ''}
</section>`;
}

export function renderDoctor(items: readonly DoctorItem[], options: DoctorViewOptions): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${options.nonce}'`,
    `script-src 'nonce-${options.nonce}'`,
  ].join('; ');
  const body = options.loading
    ? `<p>${escapeHtml(l10n.t('Checking this computer…'))}</p>`
    : items.map(itemHtml).join('\n');
  return `<!doctype html>
<html lang="${escapeHtml(options.language)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${options.nonce}">${STYLE}</style>
<title>${escapeHtml(l10n.t('FaKL Doctor'))}</title>
</head>
<body>
<div class="head">
<div>
<h1>${escapeHtml(l10n.t('FaKL Doctor'))}</h1>
<p class="lede">${escapeHtml(options.loading ? l10n.t('Checking this computer…') : headline(items))}</p>
</div>
<button type="button" id="recarregar">${escapeHtml(l10n.t('Check again'))}</button>
</div>
${body}
<script nonce="${options.nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('recarregar').addEventListener('click', () => vscode.postMessage({ type: 'recarregar' }));
for (const button of document.querySelectorAll('button[data-item]')) {
  button.addEventListener('click', () =>
    vscode.postMessage({ type: 'acao', item: button.dataset.item, indice: Number(button.dataset.indice) }));
}
</script>
</body>
</html>`;
}
