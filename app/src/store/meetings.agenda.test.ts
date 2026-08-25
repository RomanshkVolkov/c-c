import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El calendario pide las ocurrencias **al servidor**.
 *
 * Es la decisión que esta prueba protege: expandir las repeticiones en la app
 * obligaría a reescribir la regla —con sus dos cambios de hora al año— y dos
 * implementaciones acaban discrepando. Cuando eso pasa, el calendario dice
 * martes, el timbre suena el miércoles, y no hay forma de saber cuál miente.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const { useMeetingsStore } = await import("@/store/meetings.store");

const OCURRENCIA = {
  meetingId: "m-1", title: "Daily", timezone: "America/Mexico_City",
  paused: false, at: "2026-08-25T15:00:00Z",
};

beforeEach(() => {
  get.mockClear();
  get.mockResolvedValue({ success: true, data: [OCURRENCIA] });
  useMeetingsStore.setState({ agenda: [] });
});

describe("la agenda del calendario", () => {
  it("la expande el servidor, no la app", async () => {
    await useMeetingsStore.getState().fetchAgenda("org-1");
    expect(String(get.mock.calls[0]?.[0])).toContain(
      "/api/v1/organizations/org-1/meetings/agenda",
    );
  });

  it("y pide una ventana concreta", async () => {
    await useMeetingsStore.getState().fetchAgenda("org-1", 30);
    expect(String(get.mock.calls[0]?.[0])).toContain("days=30");
  });

  it("guarda lo que llega tal cual", async () => {
    await useMeetingsStore.getState().fetchAgenda("org-1");
    expect(useMeetingsStore.getState().agenda).toEqual([OCURRENCIA]);
  });

  // Una organización sin reuniones no puede dejar el calendario con lo de la
  // anterior pintado.
  it("una respuesta vacía vacía el calendario", async () => {
    useMeetingsStore.setState({ agenda: [OCURRENCIA] });
    get.mockResolvedValue({ success: true, data: [] });
    await useMeetingsStore.getState().fetchAgenda("org-2");
    expect(useMeetingsStore.getState().agenda).toEqual([]);
  });
});
