import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * El service worker de la web (`public/sw.js`), cargado con un `self` falso.
 *
 * Lo que se fija: un aviso se enseña con lo que manda el servidor (y su grupo
 * como etiqueta, para reemplazar en vez de apilar); si cac está delante no se
 * repite; colgar quita el timbre por su etiqueta; y pulsar abre la app en su
 * sitio con el id para marcarla leída, reutilizando la ventana que haya.
 */

type Handler = (event: unknown) => void;

function cargar(ventanas: Array<{ url: string; visibilityState: string; focused: boolean }>) {
  const handlers: Record<string, Handler> = {};
  const abiertas = [{ tag: "ring:sp:u", close: vi.fn() }];
  const clientes = ventanas.map((v) => ({ ...v, focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) }));
  const self = {
    addEventListener: (name: string, fn: Handler) => (handlers[name] = fn),
    skipWaiting: vi.fn(),
    registration: {
      showNotification: vi.fn(async () => {}),
      getNotifications: vi.fn(async ({ tag }: { tag: string }) => abiertas.filter((n) => n.tag === tag)),
    },
    clients: { matchAll: vi.fn(async () => clientes), openWindow: vi.fn(async () => {}), claim: vi.fn() },
  };
  const src = readFileSync(join(process.cwd(), "public/sw.js"), "utf-8");
  new Function("self", src)(self);
  const disparar = async (name: string, event: Record<string, unknown>) => {
    let espera: Promise<unknown> = Promise.resolve();
    handlers[name]({ ...event, waitUntil: (p: Promise<unknown>) => (espera = p) });
    await espera;
  };
  return { self, disparar, abiertas, clientes };
}

const pushDe = (m: unknown) => ({ data: { json: () => m } });

describe("el service worker", () => {
  let sw: ReturnType<typeof cargar>;
  beforeEach(() => {
    sw = cargar([]);
  });

  it("enseña el aviso con lo que manda el servidor, agrupado por su etiqueta", async () => {
    await sw.disparar("push", pushDe({ id: "n-1", kind: "chat:message", title: "#general", body: "Ana: hola", link: "/chat?space=s", tag: "space:s" }));
    expect(sw.self.registration.showNotification).toHaveBeenCalledWith(
      "#general",
      expect.objectContaining({ body: "Ana: hola", tag: "space:s", renotify: true, data: expect.objectContaining({ id: "n-1", link: "/chat?space=s" }) }),
    );
  });

  it("si cac está delante, no lo repite", async () => {
    sw = cargar([{ url: "https://cac.guz-studio.dev/app/chat", visibilityState: "visible", focused: true }]);
    await sw.disparar("push", pushDe({ kind: "chat:message", title: "x" }));
    expect(sw.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it("colgar quita el timbre por su etiqueta, sin enseñar nada", async () => {
    await sw.disparar("push", pushDe({ kind: "voice.ring.cancel", tag: "ring:sp:u" }));
    expect(sw.abiertas[0].close).toHaveBeenCalled();
    expect(sw.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it("pulsar abre la app en su sitio, con el id para marcarla leída", async () => {
    const close = vi.fn();
    await sw.disparar("notificationclick", { notification: { close, data: { id: "n-1", link: "/tasks?task=it-1" } } });
    expect(close).toHaveBeenCalled();
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith("/app/tasks?task=it-1&notif=n-1");
  });

  it("y si ya hay una ventana de cac, la usa en vez de abrir otra", async () => {
    sw = cargar([{ url: "https://cac.guz-studio.dev/app/overview", visibilityState: "hidden", focused: false }]);
    await sw.disparar("notificationclick", { notification: { close: vi.fn(), data: { id: "n-2", link: "/dm" } } });
    expect(sw.clientes[0].navigate).toHaveBeenCalledWith("/app/dm?notif=n-2");
    expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
  });
});
