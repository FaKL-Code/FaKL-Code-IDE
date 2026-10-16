import { l10n } from '@fakl/i18n';
import type { Run, RunStatus, Task, TaskStatus } from '@fakl/protocol';

import { app } from '../app.js';
import { h, icon, markdown, patch, toast } from '../dom.js';
import { ago, folderName, groupTasks, latestRun, stateLabel, type Tone } from '../model.js';
import { chip, empty, section, type View } from './parts.js';
import { criarDitado } from './voz.js';

const RUN_TONE: Record<RunStatus, Tone> = {
  executando: 'ativo',
  pausada: 'pausa',
  'aguardando-decisão': 'atencao',
  concluída: 'bom',
  falhou: 'ruim',
  descartada: 'neutro',
};

function runLabel(status: RunStatus): string {
  switch (status) {
    case 'executando':
      return l10n.t('Running');
    case 'pausada':
      return l10n.t('On hold');
    case 'aguardando-decisão':
      return l10n.t('Needs a decision');
    case 'concluída':
      return l10n.t('Completed');
    case 'falhou':
      return l10n.t('Failed');
    case 'descartada':
      return l10n.t('Discarded');
  }
}

/** Estado da tarefa sem execução, em minúsculas como chegava do Core. */
function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'nova':
      return l10n.t('new');
    case 'executando':
      return l10n.t('running');
    case 'pausada':
      return l10n.t('paused');
    case 'concluída':
      return l10n.t('completed');
    case 'falhou':
      return l10n.t('failed');
    case 'cancelada':
      return l10n.t('canceled');
  }
}

function runChip(run: Run | undefined, task: Task): HTMLElement {
  if (run) return chip(runLabel(run.status), RUN_TONE[run.status]);
  return chip(taskStatusLabel(task.status), task.status === 'falhou' ? 'ruim' : 'neutro');
}

function modelLabel(profile: (typeof app.profiles)[number]['profile']): string {
  return `${profile.nome} · ${profile.modelo ?? profile.provedor}`;
}

function runActions(run: Run): HTMLElement | false {
  if (!app.can('comandar')) return false;
  const action = (label: string, method: string, primary = false): HTMLElement =>
    h(
      'button',
      {
        class: primary ? 'primario pequeno' : 'pequeno',
        type: 'button',
        onclick: () => void app.call(method, { runId: run.id }),
      },
      label,
    );
  const live = ['executando', 'pausada', 'aguardando-decisão'].includes(run.status);
  if (!live) return false;
  return h(
    'div',
    { class: 'acoes' },
    run.status === 'executando' && action(l10n.t('Pause'), 'runs.pause'),
    run.status === 'pausada' && action(l10n.t('Resume'), 'runs.resume', true),
    action(l10n.t('Stop'), 'runs.stop'),
  );
}

function taskCard(task: Task): HTMLElement {
  const run = latestRun(task, app.runs);
  const agents = run?.agentes.length ?? 0;
  return h(
    'article',
    { class: 'cartao-tarefa', 'data-tarefa': task.id, 'data-execucao': run?.id ?? '' },
    h(
      'button',
      {
        class: 'cartao-toque',
        type: 'button',
        onclick: () => {
          app.go({ name: 'tarefa', taskId: task.id });
        },
      },
      h(
        'span',
        { class: 'cartao-corpo' },
        h('span', { class: 'cartao-linha' }, h('span', { class: 'cartao-nome' }, task.titulo)),
        h(
          'span',
          { class: 'cartao-linha' },
          runChip(run, task),
          h(
            'span',
            { class: 'meta' },
            [
              folderName(task.repoPath),
              ago(task.criadaEm),
              agents === 1 ? l10n.t('1 agent') : agents > 1 ? l10n.t('{0} agents', agents) : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        ),
        run?.resumo && h('span', { class: 'cartao-fala' }, run.resumo),
      ),
    ),
    run && runActions(run),
  );
}

/** As tarefas do maestro: em andamento no topo, recentes embaixo. */
export function tasksView(): View {
  const el = h('div', { class: 'tela tarefas' });
  const update = (): void => {
    if (!app.loaded) {
      el.replaceChildren(empty(l10n.t('Loading tasks…')));
      return;
    }
    const { andamento, recentes } = groupTasks(app.tasks, app.runs);
    patch(
      el,
      h(
        'div',
        { class: 'resumo' },
        h(
          'p',
          { class: 'resumo-texto' },
          andamento.length > 0
            ? l10n.t('{0} in progress', andamento.length)
            : l10n.t('No tasks in progress'),
        ),
        app.can('comandar') &&
          h(
            'button',
            {
              class: 'primario pequeno',
              type: 'button',
              onclick: () => {
                app.go({ name: 'nova-tarefa' });
              },
            },
            icon('mais', 16),
            l10n.t('New task'),
          ),
      ),
      andamento.length > 0
        ? section(l10n.t('In progress'), andamento.length, ...andamento.map(taskCard))
        : false,
      recentes.length > 0
        ? section(l10n.t('Recent'), undefined, ...recentes.slice(0, 30).map(taskCard))
        : andamento.length === 0
          ? empty(
              l10n.t('No tasks yet.'),
              l10n.t('A task hands the work to a maestro, who splits it among agents.'),
            )
          : false,
    );
  };
  update();
  return { el, update };
}

export function taskView(taskId: string): View {
  const el = h('div', { class: 'tela tarefa' });
  const task = (): Task | undefined => app.tasks.find((t) => t.id === taskId);
  const update = (): void => {
    const current = task();
    if (!current) {
      el.replaceChildren(empty(l10n.t('Task not found.')));
      return;
    }
    const runs = current.runs.flatMap((id) => app.runs.get(id) ?? []).reverse();
    patch(
      el,
      h('h1', { class: 'tela-titulo' }, current.titulo),
      h(
        'p',
        { class: 'meta' },
        [
          current.repoPath,
          current.entrega ? l10n.t('delivery {0}', current.entrega) : l10n.t('default delivery'),
          ago(current.criadaEm),
        ].join(' · '),
      ),
      current.descricao && h('div', { class: 'cartao' }, markdown(current.descricao)),
      app.can('comandar') &&
        !runs.some((r) => ['executando', 'pausada', 'aguardando-decisão'].includes(r.status)) &&
        h(
          'button',
          {
            class: 'primario',
            type: 'button',
            onclick: () =>
              void app.call('runs.start', { taskId }).then((r) => {
                if (r !== undefined) toast(l10n.t('Run started.'));
              }),
          },
          runs.length > 0 ? l10n.t('Start again') : l10n.t('Start'),
        ),
      ...runs.map((run) => runCard(run)),
    );
  };
  update();
  return { el, update, title: () => task()?.titulo ?? l10n.t('Task') };
}

function runCard(run: Run): HTMLElement {
  return h(
    'div',
    { class: 'cartao execucao' },
    h(
      'div',
      { class: 'cartao-linha' },
      chip(runLabel(run.status), RUN_TONE[run.status]),
      h('span', { class: 'meta' }, `${ago(run.inicio)} · ${run.branch}`),
    ),
    run.resumo && markdown(run.resumo),
    run.motivo && h('p', { class: 'meta' }, run.motivo),
    run.rodadas.length > 0 &&
      h(
        'ul',
        { class: 'rodadas' },
        ...run.rodadas.map((round) =>
          h(
            'li',
            {},
            h(
              'span',
              { class: 'rodada-nome' },
              l10n.t('Round {0}', round.numero),
              round.veredito &&
                chip(
                  round.veredito === 'passou' ? l10n.t('passed') : l10n.t('failed'),
                  round.veredito === 'passou' ? 'bom' : 'ruim',
                ),
            ),
            ...round.verificacoes.map((check) =>
              h(
                'span',
                { class: `verificacao ${check.ok ? 'bom' : 'ruim'}` },
                icon(check.ok ? 'check' : 'x', 13),
                check.nome,
              ),
            ),
          ),
        ),
      ),
    run.agentes.length > 0 &&
      h(
        'ul',
        { class: 'arvore' },
        ...run.agentes.map((member) => {
          const agent = app.agent(member.sessionId);
          return h(
            'li',
            { style: `--nivel:${String(member.profundidade)}` },
            h(
              'button',
              {
                class: 'link',
                type: 'button',
                onclick: () => {
                  app.go({ name: 'conversa', sessionId: member.sessionId });
                },
              },
              `${agent?.nome ?? member.profileId} · ${member.papel}`,
            ),
            agent && h('span', { class: 'meta' }, stateLabel(agent.state)),
          );
        }),
      ),
    run.prUrl &&
      h(
        'a',
        { class: 'botao', href: run.prUrl, target: '_blank', rel: 'noopener noreferrer' },
        icon('link', 16),
        l10n.t('Open PR'),
      ),
    runActions(run),
  );
}

export function newTaskView(): View {
  const repos = [...new Set(app.tasks.map((t) => t.repoPath))];
  const maestros = app.profiles.filter((p) => p.profile.podeSerMaestro);
  const profiles = app.profiles.map((entry) => entry.profile);
  const titulo = h('input', { type: 'text', required: true, maxlength: '200' });
  const descricao = h('textarea', {
    id: 'nova-descricao',
    rows: '5',
    placeholder: l10n.t('What the maestro should do'),
  });
  const ditado = criarDitado(descricao);
  const repo = h('input', {
    type: 'text',
    list: 'repos-tarefa',
    required: true,
    value: repos[0] ?? '',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const criterio = h('input', {
    type: 'text',
    placeholder: 'pnpm test; pnpm lint',
    spellcheck: 'false',
  });
  const maestro = h(
    'select',
    {},
    h('option', { value: '' }, l10n.t('IDE default')),
    ...maestros.map((p) => h('option', { value: p.profile.id }, modelLabel(p.profile))),
  );
  const permittedProfiles = profiles.map((profile) => {
    const checkbox = h('input', { type: 'checkbox', checked: true });
    return {
      id: profile.id,
      checkbox,
      row: h('label', { class: 'opcao' }, checkbox, h('span', {}, modelLabel(profile))),
    };
  });
  const entrega = h(
    'select',
    {},
    h('option', { value: '' }, l10n.t('IDE default')),
    h('option', { value: 'pr-merge' }, l10n.t('PR + merge to main')),
    h('option', { value: 'pr' }, l10n.t('Open PR')),
    h('option', { value: 'branch' }, l10n.t('Leave on the branch')),
    h('option', { value: 'merge' }, l10n.t('Local merge')),
  );
  const submit = h('button', { class: 'primario', type: 'submit' }, l10n.t('Create and start'));
  const el = h(
    'form',
    {
      class: 'tela formulario',
      onsubmit: (event: Event) => {
        event.preventDefault();
        submit.setAttribute('disabled', '');
        void (async () => {
          const comandos = criterio.value
            .split(';')
            .map((c) => c.trim())
            .filter(Boolean);
          const created = await app.call<Task>('tasks.create', {
            titulo: titulo.value.trim(),
            descricao: descricao.value.trim() || undefined,
            repoPath: repo.value.trim(),
            origem: 'remoto',
            ...(comandos.length > 0 ? { criterio: { comandos } } : {}),
            ...(maestro.value ? { maestroProfileId: maestro.value } : {}),
            perfisPermitidos: permittedProfiles
              .filter((profile) => profile.checkbox.checked)
              .map((profile) => profile.id),
            ...(entrega.value ? { entrega: entrega.value } : {}),
          });
          submit.removeAttribute('disabled');
          if (!created) return;
          await app.call('runs.start', { taskId: created.id });
          toast(l10n.t('Task created.'));
          await app.refreshTasks();
          app.replace({ name: 'tarefa', taskId: created.id });
        })();
      },
    },
    h('label', {}, l10n.t('Title'), titulo),
    h('label', { for: 'nova-descricao' }, l10n.t('What to do')),
    h('div', { class: 'voz-campo' }, descricao, ditado.botao),
    h('label', {}, l10n.t('Repository (path on the machine)'), repo),
    h('datalist', { id: 'repos-tarefa' }, ...repos.map((r) => h('option', { value: r }))),
    h('label', {}, l10n.t('Done criteria (commands separated by ;)'), criterio),
    h(
      'div',
      { class: 'duas' },
      h('label', {}, l10n.t('Maestro model'), maestro),
      h('label', {}, l10n.t('Delivery'), entrega),
    ),
    h(
      'fieldset',
      { class: 'modelos-permitidos' },
      h('legend', {}, l10n.t('Models the maestro can call')),
      ...(permittedProfiles.length > 0
        ? permittedProfiles.map((profile) => profile.row)
        : [h('p', { class: 'meta' }, l10n.t('No model profile configured.'))]),
    ),
    submit,
  );
  return {
    el,
    update: () => undefined,
    title: () => l10n.t('New task'),
    dispose: () => {
      ditado.cancelar();
    },
  };
}
