import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * En el escritorio el aviso va por `desktop_notify`, que lo firma «C-C» y le
 * pone el logo; en la web, por el plugin (la API del navegador).
 * Mutante: mandar siempre por el plugin (en Linux sale «app» y sin logo).
 */

const { invoke, sendNotification, platform } = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
  sendNotification: vi.fn(),
  platform: { isTauri: true },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification }));
vi.mock("@/lib/platform", () => ({
  get isTauri() {
    return platform.isTauri;
  },
}));

beforeEach(() => {
  invoke.mockClear();
  sendNotification.mockClear();
  vi.resetModules();
});

describe("un aviso del sistema", () => {
  it("en el escritorio va por desktop_notify", async () => {
    platform.isTauri = true;
    const { showDesktopNotification } = await import("@/lib/desktop-notify");
    await showDesktopNotification({ title: "Nuevo reporte", body: "Acme · 12" });
    expect(invoke).toHaveBeenCalledWith("desktop_notify", { title: "Nuevo reporte", body: "Acme · 12" });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("en la web, por el plugin", async () => {
    platform.isTauri = false;
    const { showDesktopNotification } = await import("@/lib/desktop-notify");
    await showDesktopNotification({ title: "t", body: "b" });
    expect(sendNotification).toHaveBeenCalledWith({ title: "t", body: "b" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
