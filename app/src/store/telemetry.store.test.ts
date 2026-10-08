import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El store de Diagnóstico.
 *
 * Lo que se fija: un dispositivo se elige por proyecto **y** id (elegir sólo
 * por id mezclaba los timelines de un teléfono que manda a dos proyectos); los
 * filtros viajan al servidor; un fallo se enseña en vez de tragarse; y una
 * respuesta que llega tarde, de una selección anterior, no pisa la actual.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get } }));

const { useTelemetryStore, DEFAULT_FILTERS, TIMELINE_PAGE, timelinePath } = await import("./telemetry.store");

const ok = (data: unknown) => ({ success: true, data });

beforeEach(() => {
  useTelemetryStore.getState().reset();
  get.mockReset();
});

const params = (url: string) => new URL(url, "http://x").searchParams;

describe("elegir un dispositivo", () => {
  it("pide la ficha y el timeline de ese proyecto, no los de todos", async () => {
    get.mockImplementation(async (url: string) => (url.includes("/timeline") ? ok([]) : ok({ deviceId: "d1" })));
    await useTelemetryStore.getState().select({ projectId: "p2", deviceId: "d1" });
    const urls = get.mock.calls.map((c) => c[0] as string);
    const timeline = urls.find((u) => u.includes("/timeline"))!;
    expect(params(timeline).get("projectId")).toBe("p2");
    expect(params(timeline).get("deviceId")).toBe("d1");
    expect(urls).toContain("/api/v1/telemetry/devices/p2/d1");
  });

  it("un fallo del timeline se enseña, no se traga", async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes("/timeline")) throw new Error("500 boom");
      return ok({ deviceId: "d1" });
    });
    await useTelemetryStore.getState().select({ projectId: "p", deviceId: "d1" });
    expect(useTelemetryStore.getState().timelineError).toContain("boom");
    expect(useTelemetryStore.getState().loadingTimeline).toBe(false);
  });

  it("un fallo de la ficha también", async () => {
    get.mockImplementation(async (url: string) => (url.includes("/timeline") ? ok([]) : { success: false, error: "device-not-found" }));
    await useTelemetryStore.getState().select({ projectId: "p", deviceId: "d1" });
    expect(useTelemetryStore.getState().detailError).toBe("device-not-found");
  });

  it("la respuesta de una selección anterior no pisa la actual", async () => {
    let release: (v: unknown) => void = () => {};
    get.mockImplementation((url: string) => {
      if (url.includes("deviceId=viejo")) return new Promise((r) => (release = r));
      return Promise.resolve(url.includes("/timeline") ? ok([{ id: "nuevo", breadcrumbs: [] }]) : ok({ deviceId: "x" }));
    });
    const first = useTelemetryStore.getState().select({ projectId: "p", deviceId: "viejo" });
    await useTelemetryStore.getState().select({ projectId: "p", deviceId: "nuevo" });
    release(ok([{ id: "viejo", breadcrumbs: [] }]));
    await first;
    expect(useTelemetryStore.getState().timeline.map((b) => b.id)).toEqual(["nuevo"]);
  });
});

describe("los filtros", () => {
  it("viajan al servidor; el texto no", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    const q = params(timelinePath({ projectId: "p", deviceId: "d" },
      { types: ["heartbeat", "network"], minSeverity: "warn", sessionId: "s9", sinceHours: 6, text: "gps" }, "2026-10-07T11:00:00Z", now));
    expect(q.get("types")).toBe("heartbeat,network");
    expect(q.get("minSeverity")).toBe("warn");
    expect(q.get("sessionId")).toBe("s9");
    expect(q.get("since")).toBe(String(now - 6 * 3_600_000));
    expect(q.get("before")).toBe("2026-10-07T11:00:00Z");
    expect([...q.keys()]).not.toContain("text");
  });

  it("sin filtros no manda ninguno", () => {
    const q = params(timelinePath({ projectId: "p", deviceId: "d" }, DEFAULT_FILTERS, null));
    expect([...q.keys()].sort()).toEqual(["deviceId", "limit", "projectId"]);
  });

  it("cambiar el texto no vuelve a pedir; cambiar la gravedad sí", async () => {
    get.mockResolvedValue(ok([]));
    useTelemetryStore.setState({ selected: { projectId: "p", deviceId: "d" } });
    await useTelemetryStore.getState().setFilters({ text: "x" });
    expect(get).not.toHaveBeenCalled();
    await useTelemetryStore.getState().setFilters({ minSeverity: "error" });
    expect(params(get.mock.calls[0][0]).get("minSeverity")).toBe("error");
  });

  it("una página llena deja pedir más desde su último lote", async () => {
    const page = Array.from({ length: TIMELINE_PAGE }, (_, i) => ({ id: String(i), receivedAt: `t${i}`, breadcrumbs: [] }));
    get.mockResolvedValue(ok(page));
    useTelemetryStore.setState({ selected: { projectId: "p", deviceId: "d" } });
    await useTelemetryStore.getState().setFilters({ minSeverity: "info" });
    expect(useTelemetryStore.getState().timelineBefore).toBe(`t${TIMELINE_PAGE - 1}`);
    get.mockResolvedValue(ok([{ id: "más", receivedAt: "z", breadcrumbs: [] }]));
    await useTelemetryStore.getState().loadMoreTimeline();
    expect(params(get.mock.calls[1][0]).get("before")).toBe(`t${TIMELINE_PAGE - 1}`);
    expect(useTelemetryStore.getState().timeline).toHaveLength(TIMELINE_PAGE + 1);
    expect(useTelemetryStore.getState().timelineBefore).toBeNull();
  });
});

describe("la lista", () => {
  it("busca en el servidor y pagina con el cursor de la última fila", async () => {
    get.mockResolvedValueOnce(ok([{ deviceId: "a" }, { deviceId: "b", cursor: "C1" }]));
    await useTelemetryStore.getState().setQuery("moto");
    expect(params(get.mock.calls[0][0]).get("q")).toBe("moto");
    expect(useTelemetryStore.getState().devicesCursor).toBe("C1");
    get.mockResolvedValueOnce(ok([{ deviceId: "c" }]));
    await useTelemetryStore.getState().fetchDevices(true);
    expect(params(get.mock.calls[1][0]).get("cursor")).toBe("C1");
    expect(useTelemetryStore.getState().devices.map((d) => d.deviceId)).toEqual(["a", "b", "c"]);
    expect(useTelemetryStore.getState().devicesCursor).toBeNull();
  });

  it("un fallo se enseña", async () => {
    get.mockRejectedValueOnce(new Error("offline"));
    await useTelemetryStore.getState().fetchDevices();
    expect(useTelemetryStore.getState().error).toBe("offline");
  });
});
