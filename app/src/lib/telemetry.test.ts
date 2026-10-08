import { describe, expect, it } from "vitest";
import {
  crumbFields,
  crumbTitle,
  deviceTitle,
  duration,
  flattenTimeline,
  heartbeatStrip,
  matchesText,
} from "./telemetry";
import type { TelemetryEventView } from "@/types/telemetry";

const batch = (over: Partial<TelemetryEventView>): TelemetryEventView => ({
  id: "b", projectId: "p", deviceId: "d", sessionId: "s1", platform: "android", appVersion: "1",
  reqCount: 0, errorCount: 0, receivedAt: "2026-10-07T10:10:00Z", device: null, breadcrumbs: [],
  ...over,
});

const ms = (iso: string) => Date.parse(iso);

describe("el timeline plano", () => {
  it("va por la hora de cada crumb, no por el lote, la más nueva arriba", () => {
    // El lote más nuevo trae una petición anterior al error del lote viejo.
    const rows = flattenTimeline([
      batch({ id: "nuevo", receivedAt: "2026-10-07T10:10:00Z",
        breadcrumbs: [{ type: "network", ts: ms("2026-10-07T10:01:00Z") }], severities: ["info"] }),
      batch({ id: "viejo", receivedAt: "2026-10-07T10:06:00Z",
        breadcrumbs: [{ type: "error", ts: ms("2026-10-07T10:05:00Z") }], severities: ["error"] }),
    ]);
    expect(rows.map((r) => r.batchId)).toEqual(["viejo", "nuevo"]);
    expect(rows[0].severity).toBe("error");
  });

  it("un crumb sin ts toma la hora de su lote", () => {
    const rows = flattenTimeline([batch({ receivedAt: "2026-10-07T10:10:00Z", breadcrumbs: [{ type: "x" }] })]);
    expect(rows[0].at).toBe(ms("2026-10-07T10:10:00Z"));
  });

  it("a igual hora respeta el orden de llegada (lo último, arriba)", () => {
    const t = ms("2026-10-07T10:00:00Z");
    const rows = flattenTimeline([batch({ breadcrumbs: [{ type: "a", ts: t }, { type: "b", ts: t }] })]);
    expect(rows.map((r) => r.crumb.type)).toEqual(["b", "a"]);
  });

  it("marca dónde empieza otra sesión", () => {
    const rows = flattenTimeline([
      batch({ id: "1", sessionId: "s2", breadcrumbs: [{ ts: 3 }, { ts: 2 }] }),
      batch({ id: "2", sessionId: "s1", breadcrumbs: [{ ts: 1 }] }),
    ]);
    expect(rows.map((r) => r.sessionStart)).toEqual([false, false, true]);
  });

  it("sin gravedad del servidor, info", () => {
    expect(flattenTimeline([batch({ breadcrumbs: [{ type: "error" }] })])[0].severity).toBe("info");
  });
});

describe("un crumb", () => {
  it("un latido enseña su contenido, sin repetir lo de su línea", () => {
    const f = crumbFields({ type: "heartbeat", ts: 1, counts: { ok: 3 }, trackingActive: true });
    expect(f).toEqual([["counts", { ok: 3 }], ["trackingActive", true]]);
  });

  it("la línea de una petición es método y URL; la de lo demás, su mensaje o nombre", () => {
    expect(crumbTitle({ type: "network", method: "POST", url: "/x" })).toBe("POST /x");
    expect(crumbTitle({ type: "lifecycle", name: "DEVICE_NETWORK_CHANGED" })).toBe("DEVICE_NETWORK_CHANGED");
    expect(crumbTitle({ type: "heartbeat" })).toBe("heartbeat");
  });

  it("el texto se busca también en el contenido", () => {
    const [row] = flattenTimeline([batch({ breadcrumbs: [{ type: "heartbeat", lastPoint: { lat: 19.4 } }] })]);
    expect(matchesText(row, "19.4")).toBe(true);
    expect(matchesText(row, "nope")).toBe(false);
    expect(matchesText(row, "  ")).toBe(true);
  });
});

describe("el nombre de un dispositivo", () => {
  it("su label, o el principio del id", () => {
    expect(deviceTitle({ label: "Pixel 8", deviceId: "x" })).toBe("Pixel 8");
    expect(deviceTitle({ label: " ", deviceId: "896a3121-8967-40e9" })).toBe("896a3121…");
    expect(deviceTitle({ deviceId: "corto" })).toBe("corto");
  });
});

describe("la tira de latidos", () => {
  const from = ms("2026-10-07T10:00:00Z");
  const to = ms("2026-10-07T11:00:00Z");

  it("coloca latidos y huecos en la ventana, y recorta lo de fuera", () => {
    const marks = heartbeatStrip(
      ["2026-10-07T09:00:00Z", "2026-10-07T10:15:00Z", "2026-10-07T10:30:00Z"],
      [{ from: "2026-10-07T10:30:00Z", to: "2026-10-07T11:30:00Z", seconds: 3600, open: true }],
      from, to,
    );
    const beats = marks.filter((m) => m.kind === "beat");
    const gaps = marks.filter((m) => m.kind === "gap");
    expect(beats.map((b) => b.left)).toEqual([0.25, 0.5]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].left).toBe(0.5);
    expect(gaps[0].width).toBe(0.5);
    expect(gaps[0].open).toBe(true);
  });

  it("una ventana vacía no pinta nada", () => {
    expect(heartbeatStrip(["2026-10-07T10:15:00Z"], [], to, from)).toEqual([]);
  });
});

it("una duración se dice corta", () => {
  expect(duration(300)).toBe("5 min");
  expect(duration(3600)).toBe("1 h");
  expect(duration(7500)).toBe("2 h 5 min");
  expect(duration(90000)).toBe("1 d 1 h");
});
