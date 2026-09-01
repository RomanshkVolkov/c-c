import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMyWorkStore } from "@/store/mywork.store";
import { api } from "@/lib/api";

/**
 * «My work» enterándose de lo que pasa fuera de ella.
 *
 * Junta tareas de todas las listas, así que no tiene lista activa — y el
 * manejador de eventos se cortaba justo por eso. Mover una tarjeta desde otra
 * sesión, o desde el MCP, no cambiaba nada aquí hasta recargar la ventana; se
 * descubrió moviendo cinco seguidas mientras alguien miraba la pantalla.
 *
 * Lo delicado no es refrescar: es **no** refrescar por las que no son tuyas. En
 * una organización con movimiento, recargar por cada evento convierte esta
 * pantalla en una encuesta continua.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
}));

const tarea = (id: string) => ({ id, seq: 1, title: id, priority: "none" }) as never;

describe("el refresco de My work", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.get).mockClear();
    useMyWorkStore.setState({ tasks: [tarea("t-1")], loadedOrgId: "org-a", scope: null });
  });

  it("una tarea que tenemos provoca recarga", () => {
    useMyWorkStore.getState().refrescarSiEsNuestra("t-1");
    vi.runAllTimers();
    expect(api.get).toHaveBeenCalled();
  });

  // El que evita convertir esto en un sondeo.
  it("una que no tenemos, no", () => {
    useMyWorkStore.getState().refrescarSiEsNuestra("t-ajena");
    vi.runAllTimers();
    expect(api.get).not.toHaveBeenCalled();
  });

  /**
   * Cinco eventos seguidos, una sola petición.
   *
   * Es el caso que lo destapó: ordenar un tablero —o moverlo desde el MCP— son
   * varias tarjetas en un segundo, y todas llevan al mismo sitio.
   */
  it("una ráfaga se junta en una sola petición", () => {
    useMyWorkStore.setState({ tasks: ["t-1", "t-2", "t-3"].map(tarea) });
    for (const id of ["t-1", "t-2", "t-3", "t-1", "t-2"]) {
      useMyWorkStore.getState().refrescarSiEsNuestra(id);
    }
    vi.runAllTimers();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  // Recarga la organización que tiene cargada, no «la actual» de otro sitio:
  // si alguien cambió de organización mientras el temporizador corría, pedir la
  // nueva traería tareas que no son de la lista que se está enseñando.
  it("recarga la organización de la que son las tareas", () => {
    useMyWorkStore.getState().refrescarSiEsNuestra("t-1");
    vi.runAllTimers();
    expect(vi.mocked(api.get).mock.calls[0][0]).toContain("orgId=org-a");
  });
});
