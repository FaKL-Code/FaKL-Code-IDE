import { l10n } from '@fakl/i18n';
import type { AgentChangedFile, AgentDiffResult, AgentFileContentResult } from '@fakl/protocol';

import { app } from '../app.js';
import { lineDiff } from '../diff.js';
import { h, icon } from '../dom.js';
import { folderName } from '../model.js';
import { chip, empty, type View } from './parts.js';

function decode(base64: string | undefined): string {
  if (!base64) return '';
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const STATUS_TONE = { adicionado: 'bom', modificado: 'ativo', removido: 'ruim' } as const;

/** Rótulo do estado do arquivo, ou de como a mudança foi resolvida. */
function fileLabel(file: AgentChangedFile): string {
  switch (file.resolution ?? file.status) {
    case 'adicionado':
      return l10n.t('added');
    case 'modificado':
      return l10n.t('modified');
    case 'removido':
      return l10n.t('removed');
    case 'aplicado':
      return l10n.t('applied');
    case 'rejeitado':
      return l10n.t('rejected');
    case 'conflito':
      return l10n.t('conflict');
  }
}

function fileRow(sessionId: string, file: AgentChangedFile): HTMLElement {
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  return h(
    'li',
    {},
    h(
      'button',
      {
        class: 'arquivo',
        type: 'button',
        onclick: () => {
          app.go({ name: 'mudancas', sessionId, path: file.path });
        },
      },
      icon('arquivo', 16),
      h(
        'span',
        { class: 'arquivo-nome' },
        h('span', { class: 'mono' }, folderName(file.path)),
        dir && h('small', { class: 'meta mono' }, dir),
      ),
      h(
        'span',
        { class: 'arquivo-conta' },
        h('span', { class: 'mais' }, `+${String(file.additions ?? 0)}`),
        h('span', { class: 'menos' }, `−${String(file.deletions ?? 0)}`),
      ),
      chip(fileLabel(file), file.resolution ? 'neutro' : STATUS_TONE[file.status]),
    ),
  );
}

/** Os arquivos que o agente mudou no worktree dele, ou o diff de um arquivo. */
export function changesView(sessionId: string, path?: string): View {
  const el = h('div', { class: 'tela mudancas' }, empty(l10n.t('Loading…')));
  void (async () => {
    if (!path) {
      const diff = await app.call<AgentDiffResult>('agents.diff', { sessionId });
      if (!diff) {
        el.replaceChildren(empty(l10n.t("Couldn't read the changes.")));
        return;
      }
      el.replaceChildren(
        h('p', { class: 'meta' }, icon('ramo', 14), ` ${diff.branch}`),
        diff.files.length === 0
          ? empty(l10n.t('No changes.'))
          : h('ul', { class: 'arquivos' }, ...diff.files.map((file) => fileRow(sessionId, file))),
      );
      return;
    }
    const [base, mine] = await Promise.all([
      app.call<AgentFileContentResult>('agents.fileContent', { sessionId, path, side: 'base' }),
      app.call<AgentFileContentResult>('agents.fileContent', { sessionId, path, side: 'agente' }),
    ]);
    const lines = lineDiff(decode(base?.base64), decode(mine?.base64));
    el.replaceChildren(
      h('p', { class: 'meta mono' }, path),
      lines.length === 0
        ? empty(l10n.t('No text differences.'))
        : h(
            'pre',
            { class: 'linhas' },
            ...lines.map((line) =>
              h(
                'div',
                { class: line.tipo },
                line.tipo === 'mais'
                  ? '+ '
                  : line.tipo === 'menos'
                    ? '− '
                    : line.tipo === 'pulo'
                      ? '⋯ '
                      : '  ',
                line.texto,
              ),
            ),
          ),
    );
  })();
  return {
    el,
    update: () => undefined,
    title: () => (path ? folderName(path) : l10n.t('Changes')),
    ...(app.agent(sessionId) ? { subtitle: () => app.agent(sessionId)?.nome ?? '' } : {}),
  };
}
