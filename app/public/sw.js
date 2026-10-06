/*
 * El service worker de la versión web de cac (W2): la campana en el teléfono.
 *
 * Sólo hace dos cosas, y a propósito: enseñar un aviso cuando llega por Web
 * Push, y abrir la app en su sitio cuando se pulsa. No guarda nada en caché:
 * una app que se sirve vieja desde caché es una app que no sabe que hay
 * versión nueva, y aquí la web siempre se pide al servidor.
 *
 * El aviso es la fila de la campana tal cual la escribió el servidor (título
 * ya en el idioma de quien lo lee, cuerpo, enlace, grupo). Ver
 * backend/internal/core/domain/push.go.
 */

const BASE = "/app";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** Si hay una ventana de cac delante: entonces ya se ve, y no hace falta avisar. */
async function hayUnaVentanaDelante() {
  const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return ventanas.some((c) => c.visibilityState === "visible" && c.focused);
}

self.addEventListener("push", (event) => {
  let m = {};
  try {
    m = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  event.waitUntil(
    (async () => {
      // Colgaron antes de que contestaras: se quita el timbre de la pantalla.
      if (m.kind === "voice.ring.cancel") {
        const abiertas = await self.registration.getNotifications({ tag: m.tag });
        abiertas.forEach((n) => n.close());
        return;
      }
      if (await hayUnaVentanaDelante()) return;
      await self.registration.showNotification(m.title || "cac", {
        body: m.body || "",
        // Mismo grupo, misma notificación: diez mensajes de un canal se
        // reemplazan en vez de apilarse, como en la campana.
        tag: m.tag || undefined,
        renotify: Boolean(m.tag),
        icon: `${BASE}/icons/cac-192.png`,
        badge: `${BASE}/icons/cac-192.png`,
        requireInteraction: m.kind === "voice.ring",
        data: { id: m.id || "", link: m.link || "/", orgId: m.orgId || "" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { id, link } = event.notification.data || {};
  // `notif=` le dice a la app qué fila marcar leída al abrirse: el service
  // worker no tiene la sesión para hacerlo él.
  const sep = String(link || "/").includes("?") ? "&" : "?";
  const destino = `${BASE}${link || "/"}${id ? `${sep}notif=${encodeURIComponent(id)}` : ""}`;
  event.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const propia = ventanas.find((c) => new URL(c.url).pathname.startsWith(BASE));
      if (propia) {
        await propia.focus();
        return propia.navigate(destino);
      }
      return self.clients.openWindow(destino);
    })(),
  );
});
