import { l10n } from '@fakl/i18n';
import { PERMISSION_MODES, type AgentStartResult } from '@fakl/protocol';

import { app } from '../app.js';
import { h, toast } from '../dom.js';
import { type View } from './parts.js';
import { criarDitado } from './voz.js';

function modeLabels(): Record<(typeof PERMISSION_MODES)[number], string> {
  return {
    perguntar: l10n.t('Ask for every action'),
    'aprovar-leitura': l10n.t('Approve reads'),
    'aprovar-tudo': l10n.t('Approve all'),
    autopilot: l10n.t('Autopilot'),
  };
}

/** Pastas que a IDE já usou: repositórios das tarefas e onde os agentes trabalharam. */
function knownFolders(): string[] {
  const folders = [
    ...app.tasks.map((t) => t.repoPath),
    ...app.agents.filter((a) => !a.worktree).map((a) => a.cwd),
  ];
  return [...new Set(folders)];
}

/** Abre um agente avulso na máquina e já manda a primeira mensagem. */
export function newConversationView(): View {
  const profiles = app.profiles.map((entry) => entry.profile);
  const folders = knownFolders();
  const profile = h(
    'select',
    { required: true },
    ...profiles.map((p) => h('option', { value: p.id }, p.nome)),
  );
  const folder = h('input', {
    type: 'text',
    list: 'pastas-conversa',
    required: true,
    value: folders[0] ?? '',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const worktree = h('input', { type: 'checkbox', checked: true });
  const mode = h(
    'select',
    {},
    h('option', { value: '' }, l10n.t('Profile default')),
    ...PERMISSION_MODES.map((m) => h('option', { value: m }, modeLabels()[m])),
  );
  const message = h('textarea', {
    id: 'nova-mensagem',
    rows: '5',
    required: true,
    placeholder: l10n.t('What do you want the agent to do?'),
  });
  const ditado = criarDitado(message);
  const submit = h('button', { class: 'primario', type: 'submit' }, l10n.t('Start'));
  const el = h(
    'form',
    {
      class: 'tela formulario',
      onsubmit: (event: Event) => {
        event.preventDefault();
        const text = message.value.trim();
        if (!text) return;
        submit.setAttribute('disabled', '');
        void (async () => {
          const started = await app.call<AgentStartResult>('agents.start', {
            profileId: profile.value,
            cwd: folder.value.trim(),
            worktree: worktree.checked,
            ...(mode.value ? { permissions: mode.value } : {}),
          });
          submit.removeAttribute('disabled');
          if (!started) return;
          await app.call('agents.send', { sessionId: started.sessionId, message: text });
          await app.refreshAgents();
          toast(l10n.t('Agent started.'));
          app.replace({ name: 'conversa', sessionId: started.sessionId });
        })();
      },
    },
    profiles.length === 0
      ? h('p', { class: 'aviso' }, l10n.t("The IDE didn't report any agent profile."))
      : h('label', {}, l10n.t('Agent'), profile),
    h('label', {}, l10n.t('Folder on the machine'), folder),
    h('datalist', { id: 'pastas-conversa' }, ...folders.map((f) => h('option', { value: f }))),
    h(
      'label',
      { class: 'opcao' },
      worktree,
      h(
        'span',
        {},
        l10n.t('Work on its own branch'),
        h('small', {}, l10n.t("Your files don't change until you apply what it did.")),
      ),
    ),
    h('label', {}, l10n.t('Permissions'), mode),
    h('label', { for: 'nova-mensagem' }, l10n.t('Message')),
    h('div', { class: 'voz-campo' }, message, ditado.botao),
    submit,
  );
  return {
    el,
    update: () => undefined,
    title: () => l10n.t('New conversation'),
    dispose: () => {
      ditado.cancelar();
    },
  };
}
