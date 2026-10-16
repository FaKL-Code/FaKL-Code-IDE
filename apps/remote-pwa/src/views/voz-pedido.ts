import { l10n } from '@fakl/i18n';
import { descreverPedido, interpretar, type ContextoDeVoz, type IntencaoDeVoz } from '@fakl/voz';

import { app } from '../app.js';
import { h, toast } from '../dom.js';
import {
  enviarPedido,
  textoDoPedido,
  type Chamar,
  type EnvioDeVoz,
  type ProgressoDeEnvio,
} from '../voz-envio.js';
import { chip } from './parts.js';
import { criarDitado } from './voz.js';

/** Abaixo disto a fala não diz o que fazer e a pessoa precisa escolher. */
const CONFIANCA_MIN = 0.5;

function intencoes(): readonly { id: IntencaoDeVoz; rotulo: string }[] {
  return [
    { id: 'tarefa', rotulo: l10n.t('Task') },
    { id: 'avulsa', rotulo: l10n.t('New chat') },
    { id: 'mensagem', rotulo: l10n.t('Message') },
  ];
}

/** Pastas que a IDE já usou: repositórios das tarefas e onde os agentes trabalharam. */
function pastasConhecidas(): string[] {
  return [
    ...new Set([
      ...app.tasks.map((t) => t.repoPath),
      ...app.agents.filter((a) => !a.worktree).map((a) => a.cwd),
    ]),
  ];
}

function contextoDeVoz(conversaAberta: boolean): ContextoDeVoz {
  return {
    perfis: app.profiles.map(({ profile }) => ({
      id: profile.id,
      nome: profile.nome,
      modelo: profile.modelo ?? profile.provedor,
    })),
    repos: pastasConhecidas().map((caminho) => ({ caminho })),
    conversaAberta,
  };
}

/** Conversa que está aberta agora, se houver. */
function conversaAberta(): string | undefined {
  const rota = app.route;
  return rota.name === 'conversa' ? rota.sessionId : undefined;
}

/**
 * Folha "O que você quer?": já abre ouvindo, mostra a fala num campo
 * editável e, embaixo, como o pedido foi entendido (tarefa, conversa nova ou
 * mensagem). A pessoa confere, troca o tipo se quiser e envia.
 */
export function abrirPedidoPorVoz(): void {
  const sessionId = conversaAberta();
  const contexto = contextoDeVoz(sessionId !== undefined);
  const foco = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

  let escolhida: IntencaoDeVoz | undefined;
  let repoTocado = false;
  let perfilTocado = false;
  let enviando = false;
  /** O que o último envio já criou no Core; zera quando o pedido muda. */
  let progresso: ProgressoDeEnvio = {};
  let chaveDoEnvio = '';

  const texto = h('textarea', {
    id: 'voz-texto',
    rows: '4',
    placeholder: l10n.t('Say or type: "fix the login in the fakl project with opus"'),
    'aria-label': l10n.t('What do you want?'),
    spellcheck: 'true',
  });
  const ditado = criarDitado(texto, () => {
    atualizar();
  });
  const estado = h('p', { class: 'voz-estado meta', role: 'status' });
  const descricao = h('p', { class: 'voz-descricao' });
  const chips = h('div', { class: 'voz-chips' });
  const aviso = h('p', { class: 'voz-aviso', role: 'alert', hidden: true });
  const cartao = h('div', { class: 'cartao voz-cartao' }, descricao, chips, aviso);

  const radios = intencoes()
    .filter((i) => i.id !== 'mensagem' || sessionId !== undefined)
    .map((i) => {
      const radio = h('input', { type: 'radio', name: 'voz-intencao', value: i.id });
      radio.addEventListener('change', () => {
        escolhida = i.id;
        atualizar();
      });
      return {
        id: i.id,
        radio,
        label: h('label', { class: 'voz-opcao' }, radio, h('span', {}, i.rotulo)),
      };
    });
  const intencao = h(
    'fieldset',
    { class: 'voz-intencao' },
    h('legend', {}, l10n.t('What to do with this')),
    ...radios.map((r) => r.label),
  );

  const pasta = h('input', {
    type: 'text',
    list: 'pastas-voz',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  pasta.addEventListener('input', () => {
    repoTocado = true;
  });
  const pastaCampo = h(
    'label',
    {},
    l10n.t('Folder or repository on the machine'),
    pasta,
    h(
      'datalist',
      { id: 'pastas-voz' },
      ...pastasConhecidas().map((p) => h('option', { value: p })),
    ),
  );
  const perfil = h('select', {});
  perfil.addEventListener('change', () => {
    perfilTocado = true;
  });
  const perfilRotulo = h('span', {}, l10n.t('Agent'));
  const perfilCampo = h('label', {}, perfilRotulo, perfil);

  const enviar = h('button', { class: 'primario', type: 'submit' }, l10n.t('Send'));
  const cancelar = h(
    'button',
    {
      type: 'button',
      onclick: () => {
        fechar();
      },
    },
    l10n.t('Cancel'),
  );

  const form = h(
    'form',
    {
      class: 'voz-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        void mandar();
      },
    },
    h('div', { class: 'voz-campo' }, texto, ditado.botao),
    estado,
    cartao,
    intencao,
    pastaCampo,
    perfilCampo,
    h('div', { class: 'acoes' }, enviar, cancelar),
  );

  const folha = h(
    'div',
    {
      class: 'folha folha-voz',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'voz-titulo',
    },
    h('div', { class: 'folha-pega', 'aria-hidden': 'true' }),
    h('h2', { class: 'folha-titulo', id: 'voz-titulo' }, l10n.t('What do you want?')),
    form,
  );
  const fundo = h(
    'div',
    {
      class: 'fundo-folha',
      onclick: (event: Event) => {
        if (event.target === fundo) fechar();
      },
    },
    folha,
  );

  const intencaoAtual = (pedidoIntencao: IntencaoDeVoz | undefined): IntencaoDeVoz => {
    const valida = (i: IntencaoDeVoz | undefined): i is IntencaoDeVoz =>
      i !== undefined && (i !== 'mensagem' || sessionId !== undefined);
    return [escolhida, pedidoIntencao].find(valida) ?? 'tarefa';
  };

  function atualizar(): void {
    const fala = texto.value.trim();
    const pedido = fala ? interpretar(fala, contexto) : undefined;
    const tipo = intencaoAtual(pedido?.intencao);
    const incerto = pedido !== undefined && pedido.confianca < CONFIANCA_MIN && !escolhida;

    estado.textContent =
      ditado.estado() === 'ouvindo'
        ? l10n.t('Listening… tap the microphone to stop.')
        : ditado.estado() === 'transcrevendo'
          ? l10n.t('Transcribing…')
          : '';
    descricao.textContent = pedido
      ? descreverPedido({ ...pedido, intencao: tipo }, contexto)
      : l10n.t('Say or type the request; how I understood it shows up here.');
    chips.replaceChildren(...(pedido?.reconhecido ?? []).map((r) => chip(r, 'marca')));
    aviso.hidden = !incerto;
    aviso.textContent = incerto ? l10n.t("It's not clear what to do. Choose a type below.") : '';
    cartao.classList.toggle('incerto', incerto);
    intencao.classList.toggle('incerto', incerto);

    for (const r of radios) r.radio.checked = !incerto && r.id === tipo;

    pastaCampo.hidden = tipo === 'mensagem';
    perfilCampo.hidden = tipo === 'mensagem';
    if (tipo !== 'mensagem') {
      if (!repoTocado) {
        const padrao = tipo === 'tarefa' ? app.tasks[0]?.repoPath : pastasConhecidas()[0];
        pasta.value = pedido?.repoPath ?? padrao ?? '';
      }
      montarPerfis(tipo, pedido?.perfilId);
    }
    enviar.disabled = enviando || !fala || incerto;
  }

  /** Maestro (com "Padrão da IDE") para tarefa; qualquer perfil para conversa nova. */
  function montarPerfis(tipo: IntencaoDeVoz, citado: string | undefined): void {
    const tarefa = tipo === 'tarefa';
    perfilRotulo.textContent = tarefa ? l10n.t('Maestro') : l10n.t('Agent');
    const entradas = app.profiles.filter((p) => !tarefa || p.profile.podeSerMaestro);
    const atual = perfil.value;
    perfil.replaceChildren(
      ...(tarefa ? [h('option', { value: '' }, l10n.t('IDE default'))] : []),
      ...entradas.map((p) =>
        h(
          'option',
          { value: p.profile.id },
          `${p.profile.nome} · ${p.profile.modelo ?? p.profile.provedor}`,
        ),
      ),
    );
    const ids = entradas.map((p) => p.profile.id);
    const desejado = perfilTocado ? atual : (citado ?? atual);
    perfil.value = ids.includes(desejado) ? desejado : tarefa ? '' : (ids[0] ?? '');
  }

  async function mandar(): Promise<void> {
    if (enviando) return;
    const fala = texto.value.trim();
    if (!fala) return;
    const pedido = interpretar(fala, contexto);
    const tipo = intencaoAtual(pedido.intencao);
    const envio: EnvioDeVoz = {
      intencao: tipo,
      texto: textoDoPedido(pedido, fala),
      pedido,
      repoPath: pasta.value,
      ...(perfil.value ? { perfilId: perfil.value } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    const chave = JSON.stringify([tipo, envio]);
    if (chave !== chaveDoEnvio) progresso = {};
    chaveDoEnvio = chave;
    enviando = true;
    ditado.cancelar();
    atualizar();
    const chamar: Chamar = (method, params) => app.call(method, params);
    const resultado = await enviarPedido(chamar, envio, progresso);
    enviando = false;
    if (!resultado.ok) {
      toast(resultado.motivo, 'erro');
      atualizar();
      return;
    }
    toast(resultado.aviso);
    fechar();
    const { destino } = resultado;
    if (destino.name === 'tarefa') {
      await app.refreshTasks();
      app.go({ name: 'tarefa', taskId: destino.taskId });
    } else if (destino.sessionId !== sessionId) {
      await app.refreshAgents();
      app.go({ name: 'conversa', sessionId: destino.sessionId });
    }
  }

  function fechar(): void {
    ditado.cancelar();
    document.removeEventListener('keydown', teclas, true);
    fundo.classList.add('saindo');
    setTimeout(() => {
      fundo.remove();
    }, 200);
    foco?.focus({ preventScroll: true });
  }

  /** Esc fecha; Tab fica dentro da folha. */
  function teclas(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      fechar();
      return;
    }
    if (event.key !== 'Tab') return;
    const itens = [
      ...folha.querySelectorAll<HTMLElement>('button, input, select, textarea'),
    ].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    const primeiro = itens[0];
    const ultimo = itens.at(-1);
    if (!primeiro || !ultimo) return;
    if (event.shiftKey && document.activeElement === primeiro) {
      event.preventDefault();
      ultimo.focus();
    } else if (!event.shiftKey && document.activeElement === ultimo) {
      event.preventDefault();
      primeiro.focus();
    }
  }

  texto.addEventListener('input', atualizar);
  document.addEventListener('keydown', teclas, true);
  document.body.append(fundo);
  atualizar();
  texto.focus({ preventScroll: true });
  void ditado.iniciar();
}
