// Jornada de configuração (webview). Desenha a tela que o host calcula
// (setup-model.ts) e devolve os cliques; não decide nada sozinha.

import { l10n, useLocale } from '@fakl/i18n';

import type {
  FromSetup,
  SetupProviderRow,
  SetupStepId,
  SetupStepState,
  SetupStepView,
  SetupView,
  ToSetup,
} from '../setup-protocol.js';

interface VsCodeApi {
  postMessage(message: FromSetup): void;
  getState(): { pagina?: Pagina } | undefined;
  setState(state: { pagina?: Pagina }): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type Pagina = 'inicio' | 'fim' | SetupStepId;

const vscode = acquireVsCodeApi();
const app = document.getElementById('app') ?? document.body;

let view: SetupView | undefined;
let pagina: Pagina | undefined = vscode.getState()?.pagina;
/** Integrações marcadas na tela de início, antes de confirmar. */
let marcadas: Set<SetupStepId> | undefined;

// O host põe o idioma da IDE no <html lang>.
useLocale(document.documentElement.lang);

function estadoRotulo(estado: SetupStepState): string {
  switch (estado) {
    case 'feito':
      return l10n.t('Done');
    case 'pendente':
      return l10n.t('To do');
    case 'pulado':
      return l10n.t('Skipped');
    case 'indisponivel':
      return l10n.t('Waiting for the Core');
  }
}

function send(message: FromSetup): void {
  vscode.postMessage(message);
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') el.className = String(value);
    else el.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

function button(
  label: string,
  onClick: () => void,
  kind: 'principal' | 'secundario' | 'link' = 'secundario',
  disabled = false,
): HTMLButtonElement {
  const el = h('button', { class: `btn ${kind}`, type: 'button', disabled });
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

function irPara(next: Pagina): void {
  pagina = next;
  vscode.setState({ pagina });
  render();
  app.querySelector<HTMLElement>('h1')?.focus();
}

function escolhidas(): SetupStepView[] {
  return view?.etapas.filter((step) => step.escolhida) ?? [];
}

/** A próxima etapa escolhida depois de `atual`; no fim, o resumo. */
function proxima(atual: SetupStepId): Pagina {
  const lista = escolhidas();
  const index = lista.findIndex((step) => step.id === atual);
  return lista[index + 1]?.id ?? 'fim';
}

function anterior(atual: SetupStepId): Pagina {
  const lista = escolhidas();
  const index = lista.findIndex((step) => step.id === atual);
  return index > 0 ? (lista[index - 1]?.id ?? 'inicio') : 'inicio';
}

function chip(estado: SetupStepState): HTMLElement {
  return h('span', { class: `chip ${estado}` }, estadoRotulo(estado));
}

// ---------------------------------------------------------------- barra lateral

function lateral(): HTMLElement {
  const lista = escolhidas();
  const resolvidas = lista.filter((s) => s.estado === 'feito' || s.estado === 'pulado').length;
  const grupo = (titulo: string, steps: SetupStepView[]): HTMLElement | undefined =>
    steps.length === 0
      ? undefined
      : h(
          'section',
          {},
          h('h2', {}, titulo),
          h(
            'ol',
            {},
            ...steps.map((step) => {
              const item = h(
                'button',
                {
                  class: `passo ${step.estado}${pagina === step.id ? ' atual' : ''}`,
                  type: 'button',
                  'aria-current': pagina === step.id ? 'step' : undefined,
                },
                h('span', { class: 'ponto', 'aria-hidden': 'true' }),
                h('span', { class: 'nome' }, step.titulo),
                h('span', { class: 'visually-hidden' }, ` (${estadoRotulo(step.estado)})`),
              );
              item.addEventListener('click', () => {
                irPara(step.id);
              });
              return h('li', {}, item);
            }),
          ),
        );
  // Largura pelo CSSOM: a CSP do webview não aceita atributo style.
  const preenchido = h('span');
  preenchido.style.width = `${String(lista.length ? (100 * resolvidas) / lista.length : 0)}%`;
  return h(
    'nav',
    { class: 'lateral', 'aria-label': l10n.t('Setup steps') },
    h('div', { class: 'marca' }, h('strong', {}, 'FaKL-Code'), h('span', {}, l10n.t('Setup'))),
    h(
      'div',
      {
        class: 'progresso',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': String(lista.length),
        'aria-valuenow': String(resolvidas),
        'aria-label': l10n.t('Steps done'),
      },
      h('div', { class: 'barra' }, preenchido),
      h('small', {}, l10n.t('{0} of {1} done', resolvidas, lista.length)),
    ),
    grupo(
      l10n.t('Essentials'),
      lista.filter((step) => step.grupo === 'essencial'),
    ),
    grupo(
      l10n.t('Integrations'),
      lista.filter((step) => step.grupo === 'integracao'),
    ),
    h(
      'div',
      { class: 'rodape-lateral' },
      button(
        l10n.t('Choose integrations'),
        () => {
          irPara('inicio');
        },
        'link',
      ),
      button(
        l10n.t('Summary'),
        () => {
          irPara('fim');
        },
        'link',
      ),
    ),
  );
}

// ---------------------------------------------------------------- páginas

function inicio(): HTMLElement {
  const integracoes = view?.etapas.filter((step) => step.grupo === 'integracao') ?? [];
  marcadas ??= new Set(integracoes.filter((step) => step.escolhida).map((step) => step.id));
  const selecionadas = marcadas;
  return h(
    'article',
    { class: 'pagina inicio' },
    h('h1', { tabindex: '-1' }, l10n.t('Welcome to FaKL-Code')),
    h(
      'p',
      { class: 'lead' },
      l10n.t(
        'Let’s make the IDE yours. Nothing here is required: every step can be skipped and redone later with the "FaKL: Set up" command. With no AI provider at all, the IDE works as a full editor.',
      ),
    ),
    h(
      'p',
      {},
      l10n.t(
        'The essentials come first: language, what you already use, the theme, the AI providers you have and agent permissions. Then pick what else you want to set up now:',
      ),
    ),
    h(
      'div',
      { class: 'grade', role: 'group', 'aria-label': l10n.t('Integrations') },
      ...integracoes.map((step) => {
        const input = h('input', {
          type: 'checkbox',
          id: `int-${step.id}`,
          checked: selecionadas.has(step.id),
        });
        input.addEventListener('change', () => {
          if (input.checked) selecionadas.add(step.id);
          else selecionadas.delete(step.id);
        });
        return h(
          'label',
          { class: `opcao${step.estado === 'feito' ? ' feita' : ''}`, for: `int-${step.id}` },
          input,
          h(
            'span',
            {},
            h(
              'strong',
              {},
              step.titulo,
              step.estado === 'feito' ? h('em', {}, ` ${l10n.t('already set up')}`) : undefined,
            ),
            h('small', {}, step.resumo),
          ),
        );
      }),
    ),
    h(
      'div',
      { class: 'acoes' },
      button(
        l10n.t('Start'),
        () => {
          send({ type: 'interesses', ids: [...selecionadas] });
          irPara(escolhidas()[0]?.id ?? 'importar');
        },
        'principal',
      ),
      button(
        l10n.t('Set up later'),
        () => {
          send({ type: 'interesses', ids: [...selecionadas] });
          send({ type: 'concluir' });
        },
        'link',
      ),
    ),
  );
}

function linhaProvedor(row: SetupProviderRow): HTMLElement {
  return h(
    'li',
    { class: `provedor${row.pronto ? ' pronto' : ''}` },
    h('span', { class: 'ponto', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'info' },
      h('strong', {}, row.nome),
      h('small', {}, row.linha),
      row.aviso ? h('small', { class: 'aviso' }, row.aviso) : undefined,
    ),
    h(
      'div',
      { class: 'botoes' },
      ...row.acoes.map((acao) =>
        button(
          acao.rotulo,
          () => {
            send({ type: 'provedor', acao: acao.id, id: row.id });
          },
          acao.id === 'instalar' || acao.id === 'login' ? 'principal' : 'secundario',
        ),
      ),
    ),
  );
}

function blocoIa(): HTMLElement | undefined {
  if (!view?.provedores) return undefined;
  return h(
    'div',
    { class: 'bloco' },
    h(
      'p',
      { class: 'nota' },
      l10n.t(
        'Install and Sign in open a terminal with the command already typed: check it and press Enter. Then come back and click "Detect again". An API key stays in the system keychain and only reaches that provider’s agent.',
      ),
    ),
    h('ul', { class: 'provedores' }, ...view.provedores.map(linhaProvedor)),
    h(
      'div',
      { class: 'acoes' },
      button(l10n.t('Detect again'), () => {
        send({ type: 'detectar' });
      }),
    ),
  );
}

function blocoPermissoes(): HTMLElement | undefined {
  const permissoes = view?.permissoes;
  if (!permissoes) return undefined;
  const modos = h(
    'fieldset',
    { class: 'modos' },
    h('legend', {}, l10n.t('Default permission mode')),
    ...permissoes.opcoes.map((opcao) => {
      const input = h('input', {
        type: 'radio',
        name: 'modo',
        id: `modo-${opcao.id}`,
        value: opcao.id,
        checked: permissoes.atual === opcao.id,
      });
      input.addEventListener('change', () => {
        if (input.checked) send({ type: 'permissoes', modo: opcao.id });
      });
      return h(
        'label',
        { class: 'opcao', for: `modo-${opcao.id}` },
        input,
        h('span', {}, h('strong', {}, opcao.rotulo), h('small', {}, opcao.descricao)),
      );
    }),
  );
  const confirmar = h(
    'div',
    { class: 'acoes' },
    button(
      l10n.t('Use this mode'),
      () => {
        const marcado = modos.querySelector<HTMLInputElement>('input[name="modo"]:checked');
        const opcao = permissoes.opcoes.find((candidate) => candidate.id === marcado?.value);
        if (opcao) send({ type: 'permissoes', modo: opcao.id });
      },
      'principal',
    ),
  );
  const tetos =
    permissoes.tetos.length === 0
      ? h(
          'p',
          { class: 'nota' },
          l10n.t('Spending caps show up here once a pay-per-use provider is ready.'),
        )
      : h(
          'fieldset',
          { class: 'tetos' },
          h('legend', {}, l10n.t('Daily spending cap (optional)')),
          h(
            'p',
            { class: 'nota' },
            l10n.t(
              'When the cap is reached, that provider’s agents pause until the next day. Empty: no cap.',
            ),
          ),
          ...permissoes.tetos.map((teto) => {
            const input = h('input', {
              type: 'number',
              min: '0',
              step: '1',
              inputmode: 'decimal',
              id: `teto-${teto.provedor}`,
              value: teto.custoUsd === undefined ? '' : String(teto.custoUsd),
              placeholder: l10n.t('no cap'),
            });
            input.addEventListener('change', () => {
              const valor = input.value.trim() === '' ? null : Number(input.value);
              if (valor !== null && !(valor >= 0)) return;
              send({ type: 'teto', provedor: teto.provedor, custoUsd: valor });
            });
            return h(
              'label',
              { class: 'teto', for: `teto-${teto.provedor}` },
              h('span', {}, teto.nome),
              h('span', { class: 'campo' }, l10n.t('$'), input, h('small', {}, l10n.t('/day'))),
            );
          }),
        );
  return h('div', { class: 'bloco' }, modos, confirmar, tetos);
}

function etapa(step: SetupStepView): HTMLElement {
  const extra =
    step.id === 'ia' ? blocoIa() : step.id === 'permissoes' ? blocoPermissoes() : undefined;
  return h(
    'article',
    { class: 'pagina' },
    h('header', {}, h('h1', { tabindex: '-1' }, step.titulo), chip(step.estado)),
    h('p', { class: 'lead' }, step.resumo),
    step.detalhe ? h('p', { class: 'detalhe' }, step.detalhe) : undefined,
    step.estado === 'indisponivel'
      ? h(
          'p',
          { class: 'nota' },
          l10n.t(
            'This step depends on the FaKL Core, which has not answered yet. It unlocks by itself once the Core is up.',
          ),
        )
      : undefined,
    extra,
    step.acoes.length > 0
      ? h(
          'div',
          { class: 'acoes' },
          ...step.acoes.map((acao) =>
            button(
              acao.rotulo,
              () => {
                send({ type: 'acao', etapa: step.id, acao: acao.id });
              },
              acao.principal ? 'principal' : 'secundario',
            ),
          ),
        )
      : undefined,
    h(
      'footer',
      { class: 'navegacao' },
      button(
        l10n.t('Back'),
        () => {
          irPara(anterior(step.id));
        },
        'link',
      ),
      h('span', { class: 'espaco' }),
      step.estado === 'feito' || step.estado === 'pulado'
        ? undefined
        : button(
            l10n.t('Skip this step'),
            () => {
              send({ type: 'pular', etapa: step.id });
              irPara(proxima(step.id));
            },
            'link',
          ),
      button(
        proxima(step.id) === 'fim' ? l10n.t('See the summary') : l10n.t('Next'),
        () => {
          irPara(proxima(step.id));
        },
        'principal',
      ),
    ),
  );
}

function fim(): HTMLElement {
  const lista = escolhidas();
  const pendentes = lista.filter(
    (step) => step.estado === 'pendente' || step.estado === 'indisponivel',
  );
  return h(
    'article',
    { class: 'pagina fim' },
    h(
      'h1',
      { tabindex: '-1' },
      pendentes.length === 0 ? l10n.t('All set') : l10n.t('Almost there'),
    ),
    h(
      'p',
      { class: 'lead' },
      pendentes.length === 0
        ? l10n.t(
            'The steps you chose are taken care of. You can come back to any of them with the "FaKL: Set up" command or from the Welcome page.',
          )
        : l10n.t(
            'A few steps are left, but nothing stops you from starting. They stay on the checklist in the Welcome page.',
          ),
    ),
    h(
      'ul',
      { class: 'resumo' },
      ...lista.map((step) => {
        const item = button(
          step.titulo,
          () => {
            irPara(step.id);
          },
          'link',
        );
        return h(
          'li',
          {},
          chip(step.estado),
          item,
          step.detalhe ? h('small', {}, step.detalhe) : undefined,
        );
      }),
    ),
    h(
      'div',
      { class: 'acoes' },
      button(
        l10n.t('Finish'),
        () => {
          send({ type: 'concluir' });
        },
        'principal',
      ),
    ),
  );
}

// ---------------------------------------------------------------- tela

function render(): void {
  if (!view) {
    app.replaceChildren(h('p', { class: 'carregando' }, l10n.t('Loading…')));
    return;
  }
  pagina ??= view.abrir ?? (view.interessesEscolhidos ? 'fim' : 'inicio');
  const step = view.etapas.find((candidate) => candidate.id === pagina);
  const conteudo = pagina === 'inicio' ? inicio() : pagina === 'fim' || !step ? fim() : etapa(step);
  app.replaceChildren(
    h(
      'div',
      { class: 'layout' },
      lateral(),
      h(
        'div',
        { class: 'principal' },
        view.conectado
          ? undefined
          : h(
              'div',
              { class: 'faixa', role: 'status' },
              l10n.t(
                'Waiting for the FaKL Core. The steps that depend on it unlock by themselves once it answers.',
              ),
            ),
        conteudo,
      ),
    ),
  );
}

window.addEventListener('message', (event: MessageEvent<ToSetup>) => {
  const msg = event.data;
  const primeira = view === undefined;
  view = msg.view;
  if (view.abrir) pagina = view.abrir;
  // Atualizações não tiram o foco do campo que a pessoa está editando.
  const ativo = document.activeElement;
  if (!primeira && ativo instanceof HTMLInputElement && ativo.type === 'number') return;
  render();
});

render();
send({ type: 'ready' });
