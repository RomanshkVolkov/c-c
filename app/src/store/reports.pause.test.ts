import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pausar una integración no puede desconfigurarla.
 *
 * La regla no ha cambiado; la forma de cumplirla sí. El `PATCH` del servidor
 * reemplazaba el proyecto entero —lo que no viajaba se guardaba vacío—, así que
 * pausar perdía el webhook, su secreto y el responsable por defecto, y reanudar
 * no los devolvía porque ya no existían. La app lo tapaba **reenviando el
 * proyecto entero** en cada pausa.
 *
 * Eso arreglaba el síntoma y traía lo suyo: pausar escribía encima los valores
 * que esta pestaña tuviera cargados, que podían ser de hace una hora, y bastaba
 * con que alguien hubiera editado la integración mientras tanto para revertirle
 * el cambio sin que nadie lo pidiera.
 *
 * Ahora omitir no borra, así que la bandera va sola. Lo que se prueba es eso:
 * que el cuerpo **no lleva nada más**, porque cada campo que llevara sería un
 * campo que puede llegar viejo.
 */

// `vi.hoisted` porque la fábrica de `vi.mock` se iza por encima de cualquier
// `const` de este fichero y allí arriba todavía no existirían.
const { patch, get } = vi.hoisted(() => ({
  patch: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: { patch, get, post: vi.fn(), delete: vi.fn() } }));

const { useReportsStore } = await import("@/store/reports.store");

const PROYECTO = {
  id: "p1", orgId: "o", name: "Portento", slug: "portento",
  allowedOrigins: [], rateLimitPerHour: 60, rateLimitPerReporterPerHour: 10,
  isActive: true, platform: "app" as const,
  webhookUrl: "https://example.com/hooks/cac", webhookConfigured: true,
  defaultAssigneeUserId: "u-ana", createdAt: new Date().toISOString(),
  reportsThisMonth: 3,
};

beforeEach(() => {
  patch.mockClear();
  patch.mockResolvedValue({ success: true });
  get.mockResolvedValue({ success: true, data: [] });
  useReportsStore.setState({ projects: [PROYECTO] });
});

describe("pausar una integración", () => {
  it("manda la bandera y nada más", async () => {
    await useReportsStore.getState().setProjectActive("p1", false);
    const [url, cuerpo] = patch.mock.calls[0];
    expect(url).toBe("/api/v1/report-projects/p1");
    expect(cuerpo).toEqual({ isActive: false });
  });

  // Lo que el cuerpo **no** lleva, dicho campo por campo: es lo que se perdía
  // cuando se perdía, y lo que se pisaba cuando se reenviaba.
  it("no reenvía el webhook, su secreto ni el responsable", async () => {
    await useReportsStore.getState().setProjectActive("p1", false);
    const [, cuerpo] = patch.mock.calls[0];
    expect(cuerpo.webhookUrl).toBeUndefined();
    expect(cuerpo.webhookSecret).toBeUndefined();
    expect(cuerpo.defaultAssigneeUserId).toBeUndefined();
    expect(cuerpo.rateLimitPerHour).toBeUndefined();
  });

  it("reanudar es la misma bandera al revés", async () => {
    await useReportsStore.getState().setProjectActive("p1", true);
    expect(patch.mock.calls[0][1]).toEqual({ isActive: true });
  });

  // Ya no hace falta tener el proyecto cargado para pausarlo: antes se leía de
  // `projects` para poder reenviarlo y, si no estaba, la pausa **no ocurría**.
  it("pausa aunque la pestaña no lo tenga cargado", async () => {
    useReportsStore.setState({ projects: [] });
    await useReportsStore.getState().setProjectActive("p1", false);
    expect(patch.mock.calls[0][1]).toEqual({ isActive: false });
  });
});
