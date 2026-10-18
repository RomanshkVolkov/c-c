import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMyWorkStore } from "@/store/mywork.store";
import { api } from "@/lib/api";

/**
 * Volver a «Mi trabajo» no vuelve a pedir lo que ya tiene.
 *
 * Lo que cambia llega por eventos, así que pedir la lista entera cada vez que
 * se entra en la pantalla —desde la documentación, desde el árbol— era una
 * petición que no traía nada nuevo (jose, 18-oct-2026). Se pide sólo si cambió
 * la pregunta (org, lente, interruptor) o si la última vez falló.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.get).mockClear();
  useMyWorkStore.setState({ tasks: [], orgId: null, scope: null, lens: "all", includeClosed: false, error: null, loadedKey: null });
});

describe("cargar Mi trabajo", () => {
  it("la primera vez, pide", async () => {
    await useMyWorkStore.getState().ensureLoaded("org-a");
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("volver con la misma pregunta no pide otra vez", async () => {
    await useMyWorkStore.getState().ensureLoaded("org-a");
    await useMyWorkStore.getState().ensureLoaded("org-a");
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("otra lente, otra org o el interruptor sí piden", async () => {
    await useMyWorkStore.getState().ensureLoaded("org-a");
    useMyWorkStore.setState({ lens: "assigned" });
    await useMyWorkStore.getState().ensureLoaded("org-a");
    useMyWorkStore.setState({ includeClosed: true });
    await useMyWorkStore.getState().ensureLoaded("org-a");
    await useMyWorkStore.getState().ensureLoaded("org-b");
    expect(api.get).toHaveBeenCalledTimes(4);
  });

  it("si la última falló, se vuelve a intentar", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error("red"));
    await useMyWorkStore.getState().ensureLoaded("org-a");
    await useMyWorkStore.getState().ensureLoaded("org-a");
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  /**
   * Una tarea nueva no está en la lista, así que «si es nuestra» no la
   * encontraría nunca; y como ya no se recarga al volver, sin esto no
   * aparecería. Sí se recarga por ella, pero sólo si ya había algo cargado.
   */
  it("una tarea nueva recarga lo que ya estaba cargado", async () => {
    useMyWorkStore.getState().refrescarSiEsNuestra("t-nueva", true);
    vi.runAllTimers();
    expect(api.get).not.toHaveBeenCalled();

    await useMyWorkStore.getState().ensureLoaded("org-a");
    useMyWorkStore.getState().refrescarSiEsNuestra("t-nueva", true);
    vi.runAllTimers();
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
