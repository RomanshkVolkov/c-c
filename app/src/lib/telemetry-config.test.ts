import { describe, expect, it } from "vitest";
import { emptyRule, formErrors, fromForm, leafPaths, parseValue, toForm } from "./telemetry-config";
import type { TelemetryConfig } from "@/types/telemetry";

describe("lo que se escribe en «valor»", () => {
  it("true y false son booleanos, un número es número, lo demás texto", () => {
    expect(parseValue("==", "true")).toBe(true);
    expect(parseValue("==", " false ")).toBe(false);
    expect(parseValue("==", "905")).toBe(905);
    expect(parseValue("==", "WIFI")).toBe("WIFI");
    expect(parseValue("!=", "null")).toBe(null);
  });
  it("comparar mayor o menor pide un número", () => {
    expect(parseValue(">", "600")).toBe(600);
    expect(parseValue("<=", "0.2")).toBe(0.2);
    expect(parseValue(">", "seis")).toBeUndefined();
    expect(parseValue(">", "")).toBeUndefined();
  });
  it("exists y missing no llevan valor", () => {
    expect(parseValue("exists", "x")).toBeUndefined();
  });
});

describe("ida y vuelta", () => {
  const cfg: TelemetryConfig = {
    retentionDays: 45,
    healthRules: [
      { path: "snapshot.battery.optimizationEnabled", op: "==", value: true, severity: "warn", message: "Batería optimizada" },
      { path: "snapshot.tracking.lastCallbackAgeSeconds", op: ">", value: 600, severity: "error", message: "Rastreo parado" },
      { path: "snapshot.gps", op: "missing", severity: "error", message: "Sin GPS" },
    ],
    heartbeat: { intervalSeconds: 300, graceSeconds: 120, activeWhen: { path: "snapshot.tracking.active", op: "==", value: true } },
  };

  it("lo que se guarda vuelve igual", () => {
    expect(fromForm(toForm(cfg))).toEqual(cfg);
  });

  it("vacío es vacío: ni retención, ni reglas, ni latido", () => {
    expect(fromForm(toForm(undefined))).toEqual({});
  });

  it("una regla sin ruta no se manda", () => {
    const f = toForm(undefined);
    f.rules.push(emptyRule());
    expect(fromForm(f)).toEqual({});
  });

  it("apagar el latido lo quita entero", () => {
    const f = toForm(cfg);
    f.heartbeatOn = false;
    expect(fromForm(f).heartbeat).toBeUndefined();
  });

  it("un activeWhen vacío es «siempre»", () => {
    const f = toForm(cfg);
    f.activeWhen.path = "";
    expect(fromForm(f).heartbeat).toEqual({ intervalSeconds: 300, graceSeconds: 120 });
  });
});

describe("los errores, antes de mandar", () => {
  it("con los límites del servidor", () => {
    const f = toForm(undefined);
    f.retentionDays = "120";
    f.heartbeatOn = true;
    f.intervalSeconds = "30";
    f.rules = [{ ...emptyRule(), path: "a", op: ">", value: "x", message: "" }];
    expect(formErrors(f).map((e) => ("what" in e ? `${e.field}:${e.what}` : e.field)).sort()).toEqual(
      ["interval", "retention", "rule:message", "rule:number"].sort(),
    );
  });
  it("una configuración buena no tiene", () => {
    const f = toForm(undefined);
    f.retentionDays = "30";
    expect(formErrors(f)).toEqual([]);
  });
});

it("las rutas que se sugieren son las hojas del estado", () => {
  expect(leafPaths({ a: { b: 1, c: { d: true } }, e: [1, 2], f: null })).toEqual(["a.b", "a.c.d", "e", "f"]);
});
