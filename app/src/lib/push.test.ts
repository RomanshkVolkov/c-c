import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Encender y apagar la campana en este dispositivo (W2).
 *
 * Lo que se fija: sin llave del servidor no se pide permiso a nadie; un permiso
 * denegado no suscribe; lo que se manda al servidor es la suscripción del
 * navegador tal cual; si el servidor no la acepta se deshace la del navegador
 * (no quedar «suscrito» a nada); y apagar da de baja en los dos sitios.
 */

const { get, post, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post, delete: del } }));

const { enablePush, disablePush, keyToBytes, pushActiveHere } = await import("./push");

const sub = {
  endpoint: "https://push.example/abc?x=1",
  toJSON: () => ({ endpoint: "https://push.example/abc?x=1", keys: { p256dh: "p", auth: "a" } }),
  unsubscribe: vi.fn(async () => true),
};
const pushManager = { subscribe: vi.fn(async () => sub), getSubscription: vi.fn(async () => sub) };
const reg = { pushManager };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset().mockResolvedValue({ success: true });
  sub.unsubscribe.mockClear();
  pushManager.subscribe.mockClear();
  localStorage.clear();
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "granted") });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => reg), getRegistration: vi.fn(async () => reg), ready: Promise.resolve(reg) },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("la campana en este dispositivo", () => {
  it("la llave del servidor llega en el formato que pide el navegador", () => {
    expect(Array.from(keyToBytes("AQID_-8"))).toEqual([1, 2, 3, 255, 239]);
  });

  it("sin llave en el servidor no se pide permiso", async () => {
    get.mockResolvedValue({ success: true, data: { key: "" } });
    expect(await enablePush()).toBe("off-server");
    expect((Notification as unknown as { requestPermission: () => void }).requestPermission).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("con el permiso denegado no se suscribe", async () => {
    get.mockResolvedValue({ success: true, data: { key: "AQID" } });
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "denied") });
    expect(await enablePush()).toBe("denied");
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("encender manda al servidor la suscripción tal cual y recuerda que está encendido", async () => {
    get.mockResolvedValue({ success: true, data: { key: "AQID" } });
    post.mockResolvedValue({ success: true });
    expect(await enablePush()).toBe("on");
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(post).toHaveBeenCalledWith("/api/v1/notifications/push/subscriptions", sub.toJSON(), true);
    expect(pushActiveHere()).toBe(true);
  });

  it("si el servidor no la acepta, se deshace la del navegador", async () => {
    get.mockResolvedValue({ success: true, data: { key: "AQID" } });
    post.mockResolvedValue({ success: false, error: "push-subscribe-failed" });
    await expect(enablePush()).rejects.toThrow();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(pushActiveHere()).toBe(false);
  });

  it("apagar da de baja en el servidor y en el navegador", async () => {
    localStorage.setItem("cac-push-active", "1");
    expect(await disablePush()).toBe("off");
    expect(del).toHaveBeenCalledWith(
      "/api/v1/notifications/push/subscriptions?endpoint=" + encodeURIComponent(sub.endpoint),
      true,
    );
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(pushActiveHere()).toBe(false);
  });
});
