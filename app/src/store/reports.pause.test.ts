import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pausar una integración no puede desconfigurarla.
 *
 * El PATCH del servidor reemplaza el proyecto entero: lo que no viaja se guarda
 * vacío. Como pausar mandaba sólo nombre, orígenes y límites, el webhook, su
 * secreto y el responsable por defecto se perdían al pulsar «Pausar» — y
 * reanudar no los devolvía, porque ya no existían en ningún sitio.
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
  it("conserva el webhook y el responsable", async () => {
    await useReportsStore.getState().setProjectActive("p1", false);
    const [, cuerpo] = patch.mock.calls[0];
    expect(cuerpo.isActive).toBe(false);
    expect(cuerpo.webhookUrl).toBe("https://example.com/hooks/cac");
    expect(cuerpo.defaultAssigneeUserId).toBe("u-ana");
  });

  it("no manda un secreto vacío, que retiraría el que ya hay", async () => {
    await useReportsStore.getState().setProjectActive("p1", false);
    const [, cuerpo] = patch.mock.calls[0];
    expect(cuerpo.webhookSecret).toBeUndefined();
  });
});
