import { l10n } from '@fakl/i18n';
import { decodeKey, fingerprint } from '@fakl/remote';

import { app } from '../app.js';
import { h, icon, toast } from '../dom.js';
import { forgetMachine } from '../storage.js';
import { type View } from './parts.js';

async function enablePush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast(
      l10n.t(
        "This browser doesn't get notifications. On iPhone, add the app to the Home Screen first.",
      ),
      'erro',
    );
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast(l10n.t('Notifications not allowed.'), 'erro');
    return;
  }
  const { chave } = (await fetch('vapid.json').then((r) => r.json())) as { chave: string | null };
  if (!chave) {
    toast(l10n.t("The relay doesn't have push set up."), 'erro');
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(chave),
    }));
  const result = await app.call('remote.push.subscribe', { sub: subscription.toJSON() });
  if (result !== undefined) toast(l10n.t('Notifications on.'));
}

export function settingsView(onForget: () => void): View {
  const machine = app.machine;
  const print = h('span', { class: 'mono' }, '…');
  if (machine) {
    void fingerprint(decodeKey(machine.target.coreKey)).then((value) => {
      print.textContent = value;
    });
  }
  const status = h('dd', {});
  const el = h(
    'div',
    { class: 'tela ajustes' },
    h(
      'dl',
      { class: 'cartao kv' },
      h('dt', {}, l10n.t('Machine')),
      h('dd', {}, machine?.nome ?? ''),
      h('dt', {}, l10n.t('Connection')),
      status,
      h('dt', {}, l10n.t('Relay')),
      h('dd', { class: 'mono' }, machine?.target.relay ?? ''),
      h('dt', {}, l10n.t('IDE fingerprint')),
      h('dd', {}, print),
      h('dt', {}, l10n.t('Permissions')),
      h('dd', {}, machine?.escopos.join(', ') ?? ''),
    ),
    h(
      'button',
      { class: 'primario', type: 'button', onclick: () => void enablePush() },
      icon('sino', 18),
      l10n.t('Turn on notifications'),
    ),
    h(
      'button',
      {
        type: 'button',
        onclick: () => {
          app.disconnect();
          void app.connect();
        },
      },
      icon('atualizar', 18),
      l10n.t('Reconnect'),
    ),
    h(
      'button',
      {
        class: 'perigo',
        type: 'button',
        onclick: () => {
          if (
            !confirm(
              l10n.t(
                'Forget this machine on this device? To come back, pair again with the QR code.',
              ),
            )
          )
            return;
          app.disconnect();
          void forgetMachine().then(() => {
            app.machine = undefined;
            onForget();
          });
        },
      },
      l10n.t('Forget this machine'),
    ),
  );
  const update = (): void => {
    status.textContent =
      app.conexao === 'online'
        ? l10n.t('Connected')
        : app.conexao === 'conectando'
          ? l10n.t('connecting…')
          : app.erro
            ? l10n.t('offline ({0})', app.erro)
            : l10n.t('offline');
  };
  update();
  return { el, update, title: () => l10n.t('Settings') };
}
