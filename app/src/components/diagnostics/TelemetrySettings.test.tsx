import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Los ajustes de telemetría de un proyecto, en la ficha de su integración.
 *
 * Lo que se fija: se guarda la configuración **entera** y ya con tipos (un
 * `true` es booleano, un `600` número); lo que el servidor rechazaría se dice
 * antes y no se manda; quien no es admin la ve pero no la cambia; y las rutas
 * se sugieren con el último estado de un dispositivo del proyecto.
 */

const { get, updateProject } = vi.hoisted(() => ({ get: vi.fn(), updateProject: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get } }));
vi.mock("@/store/reports.store", () => ({
  useReportsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ updateProject }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { default: TelemetrySettings } = await import("./TelemetrySettings");
const { pick } = await import("@/test-pick");
import type { ReportProject } from "@/types/report";

const project = (over: Partial<ReportProject> = {}): ReportProject =>
  ({
    id: "p1", orgId: "o1", name: "GEOCHECK", slug: "geo", rateLimitPerHour: 20, rateLimitPerReporterPerHour: 10,
    isActive: true, webhookUrl: "", webhookConfigured: false, createdAt: "2026-10-01T00:00:00Z",
    ...over,
  }) as ReportProject;

afterEach(cleanup);
beforeEach(() => {
  updateProject.mockReset().mockResolvedValue(undefined);
  get.mockReset().mockImplementation(async (url: string) =>
    url.includes("limit=1")
      ? { success: true, data: [{ deviceId: "d1" }] }
      : { success: true, data: { device: { snapshot: { tracking: { active: true, lastCallbackAgeSeconds: 30 } } } } },
  );
});

const openIt = (p = project(), canManage = true) => {
  render(<TelemetrySettings project={p} canManage={canManage} />);
  fireEvent.click(screen.getByRole("button", { expanded: false }));
};

describe("los ajustes de telemetría", () => {
  it("guarda la configuración entera, con tipos", async () => {
    openIt();
    fireEvent.change(screen.getByRole("textbox", { name: /Keep for|Guardar/ }), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: /Add rule|Añadir regla/ }));
    fireEvent.change(screen.getByRole("combobox", { name: /^(Path|Ruta)$/ }), { target: { value: "snapshot.tracking.lastCallbackAgeSeconds" } });
    await pick(screen.getAllByRole("combobox", { name: /Condition|Condición/ })[0], ">");
    fireEvent.change(screen.getByRole("textbox", { name: /^(Value|Valor)$/ }), { target: { value: "600" } });
    await pick(screen.getByRole("combobox", { name: /Severity|Gravedad/ }), /^error$/);
    fireEvent.change(screen.getByRole("textbox", { name: /What to show|Qué enseñar/ }), { target: { value: "Rastreo parado" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^(Save|Guardar)$/ }));
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(updateProject).toHaveBeenCalledWith("p1", {
      telemetryConfig: {
        retentionDays: 45,
        healthRules: [{ path: "snapshot.tracking.lastCallbackAgeSeconds", op: ">", value: 600, severity: "error", message: "Rastreo parado" }],
        heartbeat: { intervalSeconds: 300, graceSeconds: 120 },
      },
    });
  });

  it("lo que el servidor rechazaría se dice y no se manda", () => {
    openIt();
    fireEvent.change(screen.getByRole("textbox", { name: /Keep for|Guardar/ }), { target: { value: "365" } });
    expect(screen.getByRole("alert").textContent).toMatch(/1 and 90|1 y 90/);
    const save = screen.getByRole("button", { name: /^(Save|Guardar)$/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("quien no es admin la ve, pero no la cambia", () => {
    openIt(project({ telemetryConfig: { retentionDays: 30 } }), false);
    expect((screen.getByRole("textbox", { name: /Keep for|Guardar/ }) as HTMLInputElement).value).toBe("30");
    expect((screen.getByRole("textbox", { name: /Keep for|Guardar/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^(Save|Guardar)$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add rule|Añadir regla/ })).toBeNull();
  });

  it("sugiere las rutas del último estado de un dispositivo del proyecto", async () => {
    const { container } = render(<TelemetrySettings project={project()} canManage />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    await waitFor(() => expect(container.querySelectorAll("datalist option")).toHaveLength(2));
    expect([...container.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual([
      "snapshot.tracking.active",
      "snapshot.tracking.lastCallbackAgeSeconds",
    ]);
    expect(get.mock.calls[0][0]).toContain("projectId=p1");
  });
});
