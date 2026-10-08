import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

/**
 * La pantalla de Diagnóstico, por piezas.
 *
 * Lo que se fija: dos filas del mismo teléfono en dos proyectos son dos filas,
 * y elegir una no enciende la otra; la ficha dice qué regla se incumple y la
 * marca en el árbol; un aviso se pinta como aviso, no como info; el timeline
 * va por hora; un latido enseña su contenido; y la tira marca el hueco.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get } }));

const { useTelemetryStore } = await import("@/store/telemetry.store");
const { default: DeviceList } = await import("./DeviceList");
const { default: DeviceSheet } = await import("./DeviceSheet");
const { default: Timeline } = await import("./Timeline");
const { default: HeartbeatStrip } = await import("./HeartbeatStrip");
import type { TelemetryDeviceDetail, TelemetryDeviceSummary } from "@/types/telemetry";

afterEach(cleanup);
beforeEach(() => {
  useTelemetryStore.getState().reset();
  get.mockReset();
  get.mockResolvedValue({ success: true, data: [] });
});

const summary = (over: Partial<TelemetryDeviceSummary>): TelemetryDeviceSummary => ({
  deviceId: "896a3121-8967-40e9", projectId: "p1", projectName: "GEOCHECK", platform: "android", appVersion: "2.0",
  batches: 3, reqCount: 2, errorCount: 0, warnCount: 0, lastSeen: new Date().toISOString(), alerts: [],
  ...over,
});

describe("la lista", () => {
  it("el mismo teléfono en dos proyectos son dos filas, y se elige por proyecto", () => {
    const select = vi.fn(async () => {});
    useTelemetryStore.setState({
      devices: [summary({ label: "Moto G", subject: "E-104" }), summary({ projectId: "p2", projectName: "Otro", label: "Moto G" })],
      selected: { projectId: "p2", deviceId: "896a3121-8967-40e9" },
      select,
    });
    render(<DeviceList />);
    const rows = screen.getAllByRole("button", { pressed: false }).concat(screen.getAllByRole("button", { pressed: true }));
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("button", { pressed: true }).textContent).toContain("Otro");
    fireEvent.click(screen.getByRole("button", { pressed: false }));
    expect(select).toHaveBeenCalledWith({ projectId: "p1", deviceId: "896a3121-8967-40e9" });
  });

  it("enseña el nombre y la persona, no el id, y lo que va mal", () => {
    useTelemetryStore.setState({
      devices: [summary({
        label: "Moto G", subject: "E-104", warnCount: 2,
        alerts: [{ path: "snapshot.tracking.lastCallbackAgeSeconds", severity: "error", message: "Rastreo parado", actual: 905 }],
      })],
    });
    render(<DeviceList />);
    const row = screen.getByRole("button", { pressed: false });
    expect(row.textContent).toContain("Moto G");
    expect(row.textContent).toContain("E-104");
    expect(row.textContent).toContain("Rastreo parado");
    expect(row.textContent).not.toContain("896a3121-8967-40e9");
    expect(row.textContent).toMatch(/2 (warnings|avisos)/);
  });

  it("un fallo al cargar se dice", () => {
    useTelemetryStore.setState({ error: "offline" });
    render(<DeviceList />);
    expect(screen.getByRole("alert").textContent).toContain("offline");
  });
});

const detail = (over: Partial<TelemetryDeviceDetail> = {}): TelemetryDeviceDetail => ({
  ...summary({ label: "Moto G", subject: "E-104" }),
  firstSeen: new Date().toISOString(),
  sessionId: "s1",
  device: { snapshot: { battery: { optimizationEnabled: true }, tracking: { lastCallbackAgeSeconds: 905 } } },
  alerts: [
    { path: "snapshot.tracking.lastCallbackAgeSeconds", severity: "error", message: "Rastreo parado", actual: 905 },
    { path: "snapshot.battery.optimizationEnabled", severity: "warn", message: "Batería optimizada", actual: true },
  ],
  heartbeats: [],
  gaps: [],
  ...over,
});

describe("la ficha", () => {
  it("dice qué se incumple y lo marca en el estado", () => {
    const { container } = render(<DeviceSheet detail={detail()} error={null} />);
    expect(screen.getByText("Rastreo parado")).toBeTruthy();
    expect(screen.getByText("Batería optimizada")).toBeTruthy();
    // La rama de la regla sale abierta y la hoja, marcada.
    const leaf = container.querySelector('[data-path="snapshot.tracking.lastCallbackAgeSeconds"]')!;
    expect(leaf).toBeTruthy();
    expect(leaf.className).toContain("text-error");
    expect(container.querySelector('[data-path="snapshot.battery.optimizationEnabled"]')!.className).toContain("text-warning");
  });

  it("sin alertas lo dice", () => {
    render(<DeviceSheet detail={detail({ alerts: [] })} error={null} />);
    expect(screen.getByText(/No rule is breached|No se incumple ninguna regla/)).toBeTruthy();
  });

  it("un error al cargarla se enseña", () => {
    render(<DeviceSheet detail={null} error="device-not-found" />);
    expect(screen.getByRole("alert").textContent).toContain("device-not-found");
  });
});

describe("el timeline", () => {
  it("va por hora, pinta el aviso como aviso, y un latido enseña su contenido", () => {
    const t = (iso: string) => Date.parse(iso);
    useTelemetryStore.setState({
      selected: { projectId: "p1", deviceId: "d" },
      timeline: [
        { id: "b2", projectId: "p1", deviceId: "d", sessionId: "s1", platform: "", appVersion: "", reqCount: 1, errorCount: 0,
          receivedAt: "2026-10-07T10:10:00Z", device: null,
          breadcrumbs: [{ type: "network", method: "POST", url: "/batch", status: 200, ts: t("2026-10-07T10:01:00Z") }],
          severities: ["info"] },
        { id: "b1", projectId: "p1", deviceId: "d", sessionId: "s1", platform: "", appVersion: "", reqCount: 0, errorCount: 0,
          receivedAt: "2026-10-07T10:06:00Z", device: null,
          breadcrumbs: [
            { type: "lifecycle", level: "warn", name: "DEVICE_NETWORK_CHANGED", ts: t("2026-10-07T10:05:00Z") },
            { type: "heartbeat", ts: t("2026-10-07T10:00:00Z"), counts: { accepted: 12 }, trackingActive: true },
          ],
          severities: ["warn", "info"] },
      ],
    });
    const { container } = render(<Timeline />);
    const items = [...container.querySelectorAll("li[data-severity]")];
    expect(items.map((li) => li.getAttribute("data-severity"))).toEqual(["warn", "info", "info"]);
    expect(items[0].textContent).toContain("DEVICE_NETWORK_CHANGED");
    expect(items[0].querySelector(".text-warning")).toBeTruthy();
    // El latido, abierto, enseña sus contadores.
    fireEvent.click(within(items[2] as HTMLElement).getByRole("button", { expanded: false }));
    expect(items[2].textContent).toContain("accepted");
    expect(items[2].textContent).toContain("12");
  });

  it("un error al cargar se enseña", () => {
    useTelemetryStore.setState({ selected: { projectId: "p1", deviceId: "d" }, timelineError: "500 boom" });
    render(<Timeline />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });
});

describe("la tira de latidos", () => {
  it("marca cada latido y el hueco de ahora", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    const { container } = render(
      <HeartbeatStrip
        now={now}
        detail={detail({
          heartbeat: { intervalSeconds: 300, graceSeconds: 60 },
          heartbeats: ["2026-10-07T10:00:00Z", "2026-10-07T10:05:00Z"],
          gaps: [{ from: "2026-10-07T10:05:00Z", to: "2026-10-07T12:00:00Z", seconds: 6900, open: true }],
        })}
      />,
    );
    expect(container.querySelectorAll('[data-kind="beat"]')).toHaveLength(2);
    const gap = container.querySelector('[data-kind="gap"]') as HTMLElement;
    expect(gap.style.left).toBe("4.166666666666666%");
    expect(container.textContent).toMatch(/1 h 55 min/);
  });

  it("sin latido configurado, lo dice en vez de inventar huecos", () => {
    render(<HeartbeatStrip detail={detail({ heartbeats: ["2026-10-07T10:00:00Z"] })} />);
    expect(screen.getByText(/doesn't say how often|no dice cada cuánto/)).toBeTruthy();
  });
});
