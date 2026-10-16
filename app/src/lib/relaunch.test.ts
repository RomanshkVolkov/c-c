import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const tauriRelaunch = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => tauriRelaunch() }));

import { relaunchApp } from "@/lib/relaunch";

/**
 * Mutantes: llamar al relanzado de Tauri (el que heredaba el entorno del
 * montaje); no caer a él cuando el comando no existe.
 */
describe("relanzar la app", () => {
  beforeEach(() => {
    invoke.mockReset();
    tauriRelaunch.mockReset();
  });

  it("pasa por el comando propio, no por el de Tauri", async () => {
    invoke.mockResolvedValue(undefined);
    await relaunchApp();
    expect(invoke).toHaveBeenCalledWith("relaunch_app");
    expect(tauriRelaunch).not.toHaveBeenCalled();
  });

  it("si el binario no trae el comando, cae al de Tauri", async () => {
    invoke.mockRejectedValue("command relaunch_app not found");
    await relaunchApp();
    expect(tauriRelaunch).toHaveBeenCalled();
  });
});
