import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";

/**
 * La campana en este dispositivo (W2): suscribir el navegador a Web Push.
 *
 * Sólo en la versión web. El escritorio ya avisa con sus notificaciones del
 * sistema mientras está abierto; esto es para cuando no lo está, y para el
 * teléfono. El service worker que recibe los avisos es `public/sw.js`.
 */

const PUSH_ACTIVE_KEY = "cac-push-active";

/** Si este navegador sabe recibir avisos con la app cerrada. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Registra el service worker. Una vez, al arrancar la web. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
  } catch {
    return null;
  }
}

/**
 * Si este dispositivo tiene los avisos encendidos. Se recuerda aparte de la
 * suscripción del navegador para que la pestaña abierta sepa no duplicar: con
 * push encendido, el aviso del sistema lo pone el service worker.
 */
export function pushActiveHere(): boolean {
  try {
    return localStorage.getItem(PUSH_ACTIVE_KEY) === "1";
  } catch {
    return false;
  }
}

function recordar(activo: boolean) {
  try {
    if (activo) localStorage.setItem(PUSH_ACTIVE_KEY, "1");
    else localStorage.removeItem(PUSH_ACTIVE_KEY);
  } catch {
    // Sin almacenamiento sólo se pierde el «no duplicar»: los avisos llegan igual.
  }
}

/** La llave VAPID del servidor, o vacía si el servidor no tiene push. */
export async function serverPushKey(): Promise<string> {
  const res = await api.get<APIResponse<{ key: string }>>("/api/v1/notifications/push/key", true);
  return res?.success && res.data?.key ? res.data.key : "";
}

/** La llave pública en el formato que pide `pushManager.subscribe`. */
export function keyToBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushState = "unsupported" | "off-server" | "denied" | "off" | "on";

/** En qué punto está este dispositivo. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/**
 * Encender los avisos aquí: permiso del sistema, suscripción del navegador y
 * alta en el servidor. Si el servidor no la acepta se deshace la del
 * navegador, para no quedar «suscrito» a nada.
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const key = await serverPushKey();
  if (!key) return "off-server";
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  const subscribe = () =>
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) as BufferSource });
  const send = (s: PushSubscription) =>
    api.post<APIResponse<unknown>>("/api/v1/notifications/push/subscriptions", s.toJSON(), true);
  let sub = await subscribe();
  let res = await send(sub);
  // La suscripción de este navegador es de otra persona que no salió (el
  // servidor nunca cambia el dueño). Se tira y se pide otra: endpoint nuevo,
  // sólo de quien la pide ahora; la vieja muere y el servidor la olvida.
  if (res && res.success === false && res.error === "push-not-yours") {
    await sub.unsubscribe();
    sub = await subscribe();
    res = await send(sub);
  }
  if (res && res.success === false) {
    await sub.unsubscribe();
    throw new Error(res.error ?? "push-subscribe-failed");
  }
  recordar(true);
  return "on";
}

/** Apagar los avisos aquí: baja en el servidor y en el navegador. */
export async function disablePush(): Promise<PushState> {
  recordar(false);
  if (!pushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api
      .delete(`/api/v1/notifications/push/subscriptions?endpoint=${encodeURIComponent(sub.endpoint)}`, true)
      .catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}
