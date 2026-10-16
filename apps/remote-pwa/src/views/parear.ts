import { l10n } from '@fakl/i18n';
import {
  decodeKey,
  decodePairing,
  fingerprint,
  generateKeyPair,
  pairDevice,
  type PairingPayload,
} from '@fakl/remote';

import { h, toast } from '../dom.js';
import { saveMachine, type SavedMachine } from '../storage.js';

function guessName(): string {
  const ua = navigator.userAgent;
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('Mac')) return 'Mac';
  if (ua.includes('Windows')) return 'Windows';
  return l10n.t('Browser');
}

/** Aceita o link inteiro (…/#p=…) ou só o código depois de `p=`. */
export function pairingFromText(text: string): PairingPayload {
  const value = text.trim();
  const hash = value.includes('#') ? value.slice(value.indexOf('#') + 1) : value;
  return decodePairing(new URLSearchParams(hash).get('p') ?? hash);
}

function screen(...children: (Node | false)[]): HTMLElement {
  return h(
    'main',
    { class: 'centro' },
    h('img', { src: 'icon.svg', alt: '', class: 'logo' }),
    ...children.filter((c): c is Node => Boolean(c)),
  );
}

/** Tela de boas-vindas de quem ainda não pareou. */
export function welcomeScreen(
  onPair: (payload: PairingPayload) => void,
  message?: string,
): HTMLElement {
  // No iPhone, o app da Tela de Início não enxerga o que foi pareado no Safari
  // e não recebe o link do QR; colar o link aqui pareia o próprio app.
  const link = h('input', {
    type: 'url',
    placeholder: l10n.t('Paste the pairing link here'),
    'aria-label': l10n.t('Pairing link'),
    autocomplete: 'off',
  });
  const status = h('p', { class: 'aviso', role: 'status' });
  const button = h('button', { class: 'primario', type: 'button' }, l10n.t('Pair with the link'));
  button.addEventListener('click', () => {
    try {
      onPair(pairingFromText(link.value));
    } catch {
      status.textContent = l10n.t("That isn't a pairing link. Generate another one in the IDE.");
    }
  });
  return screen(
    h('h1', {}, l10n.t('FaKL-Code remote')),
    h(
      'p',
      {},
      message ??
        l10n.t(
          'In the IDE, click the remote access icon in the status bar and choose "Pair device". Then scan the QR code with this phone\'s camera.',
        ),
    ),
    h('p', { class: 'dica' }, l10n.t('Opened from the Home Screen icon? Paste the pairing link:')),
    link,
    button,
    status,
  );
}

/** Confirmação do pareamento: a impressão tem de bater com a da IDE. */
export async function pairingScreen(
  payload: PairingPayload,
  onPaired: (machine: SavedMachine) => void,
): Promise<HTMLElement> {
  const print = await fingerprint(decodeKey(payload.k));
  const name = h('input', {
    type: 'text',
    value: guessName(),
    maxlength: '60',
    'aria-label': l10n.t('Name of this device'),
  });
  const status = h('p', { class: 'aviso', role: 'status' });
  const button = h('button', { class: 'primario', type: 'button' }, l10n.t('Pair'));
  button.addEventListener('click', () => {
    button.setAttribute('disabled', '');
    status.textContent = l10n.t('Confirm in the IDE…');
    void (async () => {
      try {
        const keys = await generateKeyPair(false);
        const target = { relay: payload.r, machine: payload.m, coreKey: payload.k };
        const result = await pairDevice(target, keys, payload.c, name.value.trim() || guessName());
        const machine: SavedMachine = {
          target,
          nome: payload.n,
          deviceId: result.id,
          escopos: result.escopos,
          keys,
        };
        await saveMachine(machine);
        history.replaceState(null, '', location.pathname);
        toast(l10n.t('Paired.'));
        onPaired(machine);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
        button.removeAttribute('disabled');
      }
    })();
  });
  return screen(
    h('h1', {}, l10n.t('Pair with {0}', payload.n)),
    h('p', {}, l10n.t('Check that the fingerprint below matches the one in the IDE:')),
    h('p', { class: 'impressao' }, print),
    h('label', {}, l10n.t('Name of this device'), name),
    button,
    status,
  );
}
