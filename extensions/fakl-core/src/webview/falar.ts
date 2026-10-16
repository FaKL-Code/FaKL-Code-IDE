import { l10n, useLocale } from '@fakl/i18n';
import type { VozStatus } from '@fakl/protocol';
import {
  descreverPedido,
  interpretar,
  type ContextoDeVoz,
  type IntencaoDeVoz,
  type PedidoDeVoz,
} from '@fakl/voz';

import { intencoesPossiveis, ROTULOS_DE_INTENCAO, vozNaIde } from '../voz-model.js';
import type { FromFalar, ToFalar } from '../voz-protocol.js';
import { atalhoDeVoz, criarMicrofone, criarTranscritor, ehAtalhoDeVoz } from './voz-mic.js';

/**
 * "Falar um pedido": grava assim que abre, transcreve pelo Core, mostra a
 * transcrição editável e o que o pedido vira (tarefa, conversa nova ou
 * mensagem para a conversa ativa). Nada é enviado sem você confirmar.
 */

interface VsCodeApi {
  postMessage(message: FromFalar): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// O host põe o idioma da IDE no <html lang>.
useLocale(document.documentElement.lang);

const vscode = acquireVsCodeApi();
const post = (message: FromFalar): void => {
  vscode.postMessage(message);
};

const ICONES_DE_INTENCAO: Readonly<Record<IntencaoDeVoz, string>> = {
  tarefa: '◆',
  avulsa: '✦',
  mensagem: '↳',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

let contexto: ContextoDeVoz = { perfis: [], repos: [] };
let pedido: PedidoDeVoz | undefined;
/** Intenção escolhida à mão; vale mais que a interpretada até a próxima abertura. */
let escolhida: IntencaoDeVoz | undefined;
let enviando = false;

// --- Estrutura ---------------------------------------------------------------------

const app = document.getElementById('app') ?? document.body;
const main = el('main', { class: 'falar' });
const titulo = el('h1', { id: 'titulo' }, l10n.t('What would you like to do?'));
const sub = el(
  'p',
  { class: 'sub' },
  l10n.t(
    'Speak in Portuguese. You review the request before sending: it becomes a task for the maestro, a new conversation with an agent, or a message to the open conversation.',
  ),
);

const gravador = el('section', { class: 'gravador', 'aria-labelledby': 'titulo' });
const estadoTexto = el('p', { class: 'estado', role: 'status', 'aria-live': 'polite' });
const aviso = el('div', { class: 'aviso', hidden: '' });
const campo = el('textarea', {
  id: 'pedido',
  rows: '4',
  placeholder: l10n.t('Say or type your request…'),
  'aria-label': l10n.t('Request (editable transcript)'),
  spellcheck: 'true',
});
const transcritor = criarTranscritor(post);
const mic = criarMicrofone({
  campo,
  classe: 'mic-grande',
  tamanhoIcone: 30,
  title: true,
  transcrever: (audio) => transcritor.transcrever(audio),
  onErro: mostrarErro,
  onConfigurar: () => {
    post({ type: 'vozConfigurar' });
  },
  onEstado: () => {
    // O botão Enviar também depende do estado do microfone.
    render();
  },
});
gravador.append(mic.botao, estadoTexto);

const revisao = el('section', { class: 'revisao', 'aria-label': l10n.t('Request review') });
const rotuloCampo = el('label', { for: 'pedido', class: 'rotulo' }, l10n.t('Transcript'));
const cartao = el('div', { class: 'cartao', role: 'status', 'aria-live': 'polite' });
const resumo = el('p', { class: 'resumo' });
const chips = el('ul', { class: 'chips', 'aria-label': l10n.t('Recognized in speech') });
cartao.append(resumo, chips);

const intencoes = el('fieldset', { class: 'intencoes' });
const legenda = el('legend', {}, l10n.t('What to do'));
const duvida = el(
  'p',
  { class: 'duvida', hidden: '' },
  l10n.t("I'm not sure what you want. Choose an option."),
);
const opcoes = el('div', {
  class: 'opcoes',
  role: 'radiogroup',
  'aria-label': l10n.t('What to do'),
});
intencoes.append(legenda, duvida, opcoes);
revisao.append(rotuloCampo, campo, cartao, intencoes);

const erro = el('p', { class: 'erro', role: 'alert', hidden: '' });
const rodape = el('footer', { class: 'acoes' });
const cancelar = el('button', { type: 'button', class: 'btn' }, l10n.t('Cancel'));
cancelar.title = l10n.t('Close without sending (Esc)');
const enviar = el('button', { type: 'button', class: 'btn primario' }, l10n.t('Send'));
enviar.title = l10n.t('Send (Ctrl+Enter)');
rodape.append(
  el('span', { class: 'dica' }, l10n.t('{0} records again', atalhoDeVoz())),
  cancelar,
  enviar,
);

main.append(titulo, sub, aviso, gravador, revisao, erro, rodape);
app.append(main);

// --- Renderização ------------------------------------------------------------------

function mostrarErro(texto: string): void {
  erro.textContent = texto;
  erro.hidden = false;
  enviando = false;
  render();
}

function renderEstado(): void {
  main.dataset.estado = mic.estado;
  estadoTexto.textContent =
    mic.estado === 'ouvindo'
      ? l10n.t('Listening… Enter or the button stops and transcribes; Esc discards.')
      : mic.estado === 'transcrevendo'
        ? l10n.t('Transcribing…')
        : campo.value.trim()
          ? l10n.t('Click the microphone to keep dictating.')
          : l10n.t('Click the microphone and speak.');
}

function renderAviso(status: VozStatus | undefined): void {
  aviso.replaceChildren();
  const ide = vozNaIde(status);
  aviso.hidden = status === undefined || ide.pronta;
  if (aviso.hidden) return;
  const texto = el('span', {}, l10n.t('{0} You can still type the request here.', ide.aviso ?? ''));
  const configurar = el(
    'button',
    { type: 'button', class: 'btn' },
    l10n.t('Choose the voice mode'),
  );
  configurar.addEventListener('click', () => {
    post({ type: 'vozConfigurar' });
  });
  aviso.append(texto, configurar);
}

function interpretarCampo(): void {
  const texto = campo.value.trim();
  if (!texto) {
    pedido = undefined;
    return;
  }
  try {
    pedido = interpretar(texto, contexto);
  } catch {
    // Interpretação indisponível: o texto vai como está, e você escolhe o que fazer.
    pedido = {
      intencao: contexto.conversaAberta ? 'mensagem' : 'avulsa',
      texto,
      comecarAgora: true,
      reconhecido: [],
      confianca: 0,
    };
  }
}

function pedidoFinal(): PedidoDeVoz | undefined {
  if (!pedido) return undefined;
  const possiveis = intencoesPossiveis(contexto.conversaAberta === true);
  const intencao =
    escolhida && possiveis.includes(escolhida)
      ? escolhida
      : possiveis.includes(pedido.intencao)
        ? pedido.intencao
        : 'avulsa';
  return { ...pedido, intencao };
}

function renderOpcoes(atual: IntencaoDeVoz | undefined): void {
  const possiveis = intencoesPossiveis(contexto.conversaAberta === true);
  opcoes.replaceChildren(
    ...possiveis.map((intencao) => {
      const marcada = intencao === atual;
      const opcao = el('button', {
        type: 'button',
        role: 'radio',
        class: 'opcao',
        'aria-checked': String(marcada),
        tabindex: marcada || (!atual && intencao === possiveis[0]) ? '0' : '-1',
      });
      opcao.dataset.intencao = intencao;
      opcao.append(
        el('span', { class: 'opcao-icone', 'aria-hidden': 'true' }, ICONES_DE_INTENCAO[intencao]),
        el('span', {}, ROTULOS_DE_INTENCAO[intencao]),
      );
      opcao.disabled = !pedido;
      opcao.addEventListener('click', () => {
        escolhida = intencao;
        render();
        opcoes.querySelector<HTMLButtonElement>(`[data-intencao="${intencao}"]`)?.focus();
      });
      return opcao;
    }),
  );
}

function render(): void {
  renderEstado();
  const final = pedidoFinal();
  cartao.hidden = !final;
  if (final) {
    let linha: string;
    try {
      linha = descreverPedido(final, contexto);
    } catch {
      linha = `${ROTULOS_DE_INTENCAO[final.intencao]}: ${final.texto}`;
    }
    resumo.textContent = linha;
    cartao.dataset.intencao = final.intencao;
    chips.hidden = final.reconhecido.length === 0;
    chips.replaceChildren(...final.reconhecido.map((trecho) => el('li', {}, trecho)));
  }
  const incerto = final !== undefined && final.confianca < 0.5 && escolhida === undefined;
  intencoes.classList.toggle('incerto', incerto);
  duvida.hidden = !incerto;
  renderOpcoes(final?.intencao);
  enviar.disabled = !final || enviando || mic.estado !== 'parado';
  enviar.textContent = enviando ? l10n.t('Sending…') : l10n.t('Send');
}

// --- Ações -------------------------------------------------------------------------

function enviarPedido(): void {
  const final = pedidoFinal();
  if (!final || enviar.disabled) return;
  erro.hidden = true;
  enviando = true;
  render();
  post({ type: 'enviar', pedido: final });
}

campo.addEventListener('input', () => {
  erro.hidden = true;
  interpretarCampo();
  render();
});
enviar.addEventListener('click', enviarPedido);
cancelar.addEventListener('click', () => {
  mic.cancelar();
  post({ type: 'fechar' });
});

// Setas trocam a opção, como num grupo de rádio.
opcoes.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const botoes = [...opcoes.querySelectorAll<HTMLButtonElement>('.opcao')];
  const atual = botoes.findIndex((b) => b === document.activeElement);
  if (atual < 0) return;
  event.preventDefault();
  const passo = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  botoes[(atual + passo + botoes.length) % botoes.length]?.click();
});

document.addEventListener('keydown', (event) => {
  if (ehAtalhoDeVoz(event)) {
    event.preventDefault();
    mic.alternar();
    return;
  }
  if (mic.estado === 'ouvindo') {
    if (event.key === 'Enter') {
      event.preventDefault();
      mic.alternar();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      mic.cancelar();
    }
    return;
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    enviarPedido();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    post({ type: 'fechar' });
  }
});

// --- Mensagens da extensão ---------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<ToFalar>) => {
  const message = event.data;
  if (transcritor.receber(message)) return;
  switch (message.type) {
    case 'init':
      contexto = message.contexto;
      escolhida = undefined;
      enviando = false;
      erro.hidden = true;
      mic.definirStatus(message.status);
      renderAviso(message.status);
      interpretarCampo();
      render();
      if (message.gravar && mic.estado === 'parado') mic.alternar();
      else campo.focus();
      break;
    case 'vozStatus':
      mic.definirStatus(message.status);
      renderAviso(message.status);
      render();
      break;
    case 'erro':
      mostrarErro(message.mensagem);
      break;
  }
});

render();
post({ type: 'ready' });
