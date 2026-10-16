import { l10n } from '@fakl/i18n';
import { PERMISSION_MODES, type AgentStartParams, type PermissionPolicyName } from '@fakl/protocol';

import { modeLabel } from './conversa.js';
import { h, iconButton } from './dom.js';
import { folderName, recentFolders } from './model.js';
import type { Screen } from './panel.js';
import type { Overlay } from './store.js';

const DRAFT = 'nova';

/**
 * Nova conversa: o pedido, a pasta (as recentes primeiro), o perfil e o modo.
 * `Ctrl+Enter` começa. O atalho global do principal abre o painel aqui.
 */
export function newConversationView(overlay: Overlay): Screen {
  const message = h('textarea', {
    id: 'nova-mensagem',
    rows: '5',
    placeholder: l10n.t('What do you want the agent to do?'),
  });
  message.value = overlay.drafts.get(DRAFT);
  message.addEventListener('input', () => {
    overlay.drafts.set(DRAFT, message.value);
  });

  const folder = h('input', {
    id: 'nova-pasta',
    type: 'text',
    list: 'nova-pastas',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: l10n.t('C:/path/to/project'),
  });
  const folders = h('datalist', { id: 'nova-pastas' });
  const profile = h('select', { id: 'nova-perfil' });
  const mode = h(
    'select',
    { id: 'nova-modo' },
    h('option', { value: '' }, l10n.t('Profile default')),
    ...PERMISSION_MODES.map((value) => h('option', { value }, modeLabel(value))),
  );
  const worktree = h('input', { id: 'nova-worktree', type: 'checkbox', checked: true });
  const start = h('button', { type: 'submit', class: 'primario' }, l10n.t('Start conversation'));

  const submit = async (): Promise<void> => {
    const text = message.value.trim();
    const cwd = folder.value.trim();
    if (!text) {
      message.focus();
      overlay.notice(l10n.t('Write what the agent should do.'), 'erro');
      return;
    }
    if (!cwd) {
      folder.focus();
      overlay.notice(l10n.t('Choose the folder the agent will work in.'), 'erro');
      return;
    }
    // A trava está no Overlay: botão, formulário e Ctrl+Enter caem no mesmo lugar.
    if (overlay.isStarting) return;
    const params: AgentStartParams = {
      profileId: profile.value,
      cwd,
      worktree: worktree.checked,
      ...(mode.value ? { permissions: mode.value as PermissionPolicyName } : {}),
    };
    start.disabled = true;
    try {
      const sessionId = await overlay.startConversation(params, text);
      // Falhou: o erro já foi avisado, o rascunho fica e dá para tentar de novo.
      if (!sessionId) return;
      // O que foi digitado durante o envio é de outro pedido.
      if (message.value.trim() === text) {
        message.value = '';
        overlay.drafts.set(DRAFT, '');
      }
      await overlay.refreshAgents();
      overlay.notice(l10n.t('Conversation started.'));
      overlay.open({ name: 'conversa', sessionId });
    } finally {
      start.disabled = overlay.connection !== 'online' || overlay.profiles.length === 0;
    }
  };

  const form = h(
    'form',
    {
      class: 'nova',
      'aria-labelledby': 'nova-titulo',
      onsubmit: (event: Event) => {
        event.preventDefault();
        void submit();
      },
      onkeydown: (event: Event) => {
        const key = event as KeyboardEvent;
        if (key.key === 'Enter' && (key.ctrlKey || key.metaKey)) {
          key.preventDefault();
          void submit();
        }
      },
    },
    h(
      'div',
      { class: 'nova-topo' },
      iconButton('voltar', l10n.t('Back to the list'), () => {
        overlay.open({ name: 'inicio' });
      }),
      h('h2', { id: 'nova-titulo' }, l10n.t('New conversation')),
    ),
    h('label', { class: 'rotulo', for: 'nova-mensagem' }, l10n.t('Request')),
    message,
    h('label', { class: 'rotulo', for: 'nova-pasta' }, l10n.t('Folder')),
    folder,
    folders,
    h(
      'div',
      { class: 'nova-linha' },
      h('label', { class: 'rotulo', for: 'nova-perfil' }, l10n.t('Agent'), profile),
      h('label', { class: 'rotulo', for: 'nova-modo' }, l10n.t('Mode'), mode),
    ),
    h(
      'label',
      { class: 'marcar', for: 'nova-worktree' },
      worktree,
      l10n.t('Work in its own worktree'),
    ),
    h(
      'div',
      { class: 'nova-fim' },
      h('span', { class: 'meta' }, l10n.t('Ctrl+Enter starts')),
      start,
    ),
  );

  let profilesKey = '';
  let foldersKey = '';
  return {
    element: form,
    focus() {
      message.focus();
    },
    update() {
      const ids = overlay.profiles.map((entry) => entry.profile.id).join('|');
      if (ids !== profilesKey) {
        profilesKey = ids;
        const current = profile.value;
        profile.replaceChildren(
          ...overlay.profiles.map((entry) =>
            h('option', { value: entry.profile.id }, entry.profile.nome),
          ),
        );
        if (current) profile.value = current;
      }
      const recent = recentFolders(overlay.agents);
      if (recent.join('|') !== foldersKey) {
        foldersKey = recent.join('|');
        folders.replaceChildren(
          ...recent.map((path) => h('option', { value: path }, folderName(path))),
        );
        if (!folder.value && recent[0]) folder.value = recent[0];
      }
      start.disabled =
        overlay.isStarting || overlay.connection !== 'online' || overlay.profiles.length === 0;
    },
  };
}
