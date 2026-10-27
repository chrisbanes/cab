// Ensemble operator push worker, served at /app/service-worker.js (scope /app/).
// It has no fetch handler and keeps no cache, so an update can never serve a stale app.
// A push shows a notification; a click routes an open tab to the exact Inbox selection in
// place, or opens one. Nothing else.
const FALLBACK_TITLE = "Ensemble needs you";
const FALLBACK_URL = "/app/inbox";
const BODY = "Open Ensemble to respond.";

// The server only ever sends an Inbox link or the Settings link; anything else is ignored.
const safeUrl = (url) =>
  typeof url === "string" &&
  url.length <= 600 &&
  /^[\x21-\x7e]+$/.test(url) &&
  (url.startsWith("/app/inbox?") || url === "/app/settings#notifications");

const accepted = (payload) =>
  payload !== null &&
  typeof payload === "object" &&
  payload.v === 1 &&
  typeof payload.title === "string" &&
  payload.title.length >= 1 &&
  payload.title.length <= 200 &&
  typeof payload.tag === "string" &&
  payload.tag.length >= 1 &&
  payload.tag.length <= 256 &&
  safeUrl(payload.url);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let note = { title: FALLBACK_TITLE, url: FALLBACK_URL, tag: undefined };
  try {
    const payload = event.data.json();
    if (accepted(payload)) note = payload;
  } catch {
    // An unreadable payload still shows the fixed notification: browsers require one per push.
  }
  event.waitUntil(
    self.registration.showNotification(note.title, {
      tag: note.tag,
      data: { url: note.url },
      body: BODY,
    }),
  );
});

// A tab still running an older bundle has no listener, so a posted message alone proves nothing:
// the tab confirms on the message's port, and an unconfirmed click opens a window instead (a
// late confirmation can leave both). The window interaction a click allows is spent once, on
// focus() or on openWindow(), so focus only after the tab confirmed.
const ACK_MS = 500;
const routed = (client, url) => {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve) => {
    port1.onmessage = () => resolve(true);
    client.postMessage({ type: "ensemble.notification-open", url }, [port2]);
    setTimeout(() => resolve(false), ACK_MS);
  }).finally(() => port1.close());
};

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = data && safeUrl(data.url) ? data.url : FALLBACK_URL;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const target = windows.find((client) => {
        try {
          const address = new URL(client.url);
          return (
            address.origin === self.location.origin &&
            address.pathname.startsWith("/app/")
          );
        } catch {
          return false;
        }
      });
      if (target) {
        try {
          // The app routes in place, so an open tab keeps its unsaved input.
          if (await routed(target, url)) {
            await target.focus();
            return;
          }
        } catch {
          // A window that cannot be focused or messaged is replaced by a new one.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
