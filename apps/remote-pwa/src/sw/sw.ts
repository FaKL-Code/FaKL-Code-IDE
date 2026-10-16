/// <reference lib="webworker" />
/**
 * Service worker do app remoto: guarda a casca do app para abrir rápido e
 * mostra as notificações push (SDD 12.4). O conteúdo do push é mínimo; os
 * detalhes só aparecem dentro do app, pelo canal cifrado.
 */
import { l10n, useLocale } from '@fakl/i18n';

declare const self: ServiceWorkerGlobalScope;

// O service worker roda sem a página: escolhe o idioma pelo do navegador.
useLocale(self.navigator.language);

const CACHE = 'fakl-remoto-v2';
const SHELL = ['./', 'index.html', 'app.js', 'app.css', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/vapid.json') || url.pathname.endsWith('/saude')) return;
  // Rede primeiro, para pegar versões novas; o cache só cobre a falta de rede.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(
        async () =>
          (await caches.match(event.request)) ??
          (await caches.match('index.html')) ??
          Response.error(),
      ),
  );
});

interface PushData {
  titulo?: string;
  texto?: string;
  tag?: string;
}

self.addEventListener('push', (event) => {
  let data: PushData;
  try {
    data = (event.data?.json() ?? {}) as PushData;
  } catch {
    data = { texto: event.data?.text() ?? '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.titulo ?? 'FaKL-Code', {
      body: data.texto ?? l10n.t('Something changed in the IDE'),
      icon: 'icon.svg',
      badge: 'icon.svg',
      ...(data.tag ? { tag: data.tag } : {}),
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const open = windows[0];
      if (open) await open.focus();
      else await self.clients.openWindow('./');
    }),
  );
});

export {};
