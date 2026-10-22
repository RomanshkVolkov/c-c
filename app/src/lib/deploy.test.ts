import { describe, expect, it } from "vitest";
import { guessEnvironment, isSha, repoFromImage, runsCommit, shortRef, shortServiceName, ciNoticeStep, usesShortSha } from "./deploy";

describe("lo que se deduce de un servicio", () => {
  it("el repositorio, sin tag ni digest, y sin confundir un puerto con un tag", () => {
    expect(repoFromImage("ghcr.io/dwit-mexico/api:abc1234")).toBe("ghcr.io/dwit-mexico/api");
    expect(repoFromImage("ghcr.io/a/b:v1@sha256:ab12")).toBe("ghcr.io/a/b");
    expect(repoFromImage("registry:5000/a/b")).toBe("registry:5000/a/b");
    expect(repoFromImage("registry:5000/a/b:v1")).toBe("registry:5000/a/b");
  });

  it("el entorno por el sufijo del stack, y nada si no lo trae", () => {
    expect(guessEnvironment("beta-api-prod")).toBe("prod");
    expect(guessEnvironment("web-rrhh-dev")).toBe("dev");
    expect(guessEnvironment("cache")).toBe("");
  });

  it("el nombre del servicio sin su stack", () => {
    expect(shortServiceName("beta-api-prod_app", "beta-api-prod")).toBe("app");
    expect(shortServiceName("suelto", "otro")).toBe("suelto");
  });

  it("la referencia corta de una imagen", () => {
    expect(shortRef("ghcr.io/a/b:abc1234@sha256:ab12")).toBe("abc1234");
    expect(shortRef("registry:5000/a/b")).toBe("latest");
    expect(shortRef("")).toBe("—");
  });

  // cac#185. Roturas que detecta: no reconocer una imagen construida en el
  // servidor (lleva el servicio detrás del sha) y dejar de marcar cuál corre;
  // o tomar por commit un tag que no lo es.
  it("qué commit corre, también si se construyó en el servidor", () => {
    const sha = "f01b62f0123456789abcdef0123456789abcdef0";
    expect(runsCommit("ghcr.io/dwit/rrhh:f01b62f", sha)).toBe(true);
    expect(runsCommit("ghcr.io/dwit/rrhh:f01b62f-rrhh-prod_app", sha)).toBe(true);
    expect(runsCommit(`ghcr.io/dwit/rrhh:${sha}-rrhh-prod_app@sha256:${"a".repeat(64)}`, sha)).toBe(true);
    expect(runsCommit("ghcr.io/dwit/rrhh:abc1234-rrhh-prod_app", sha)).toBe(false);
    expect(runsCommit("ghcr.io/dwit/rrhh:latest", sha)).toBe(false);
    expect(runsCommit("ghcr.io/dwit/rrhh:v1-2", sha)).toBe(false);
  });

  it("un sha es un sha", () => {
    expect(isSha("abc1234")).toBe(true);
    expect(isSha("abc12")).toBe(false);
    expect(isSha("ABC1234")).toBe(false);
    expect(isSha("latest")).toBe(false);
  });
});

describe("el paso del CI con tags cortos", () => {
  it("un tag de siete u ocho hex es corto; uno entero, una palabra o nada, no", () => {
    expect(usesShortSha("ghcr.io/dwit-mexico/web-rrhh:9c55939")).toBe(true);
    expect(usesShortSha("registry:5000/a/b:abc1234@sha256:00")).toBe(true);
    expect(usesShortSha("ghcr.io/a/b:" + "a".repeat(40))).toBe(false);
    expect(usesShortSha("ghcr.io/a/b:latest")).toBe(false);
    expect(usesShortSha("ghcr.io/a/b")).toBe(false);
  });

  it("con tags cortos manda el corto, y con enteros el de GitHub", () => {
    const corto = ciNoticeStep("U", true);
    expect(corto).toContain("SHORT_SHA=$(git rev-parse --short=7 HEAD)");
    expect(corto).toContain('\\"sha\\":\\"$SHORT_SHA\\"');
    expect(corto).not.toContain("$GITHUB_SHA");
    const entero = ciNoticeStep("U");
    expect(entero).toContain('\\"sha\\":\\"$GITHUB_SHA\\"');
    expect(entero).not.toContain("SHORT_SHA");
  });
});

/**
 * «Update agent» espera el primer latido del agente nuevo. Un latido nuevo es
 * un `agentSeenAt` distinto del de antes de instalar: la identidad nueva tumba
 * la vieja, así que el viejo ya no puede latir. Y la versión que instala la app
 * es la de `swarm-manage/VERSION`.
 * Mutantes: dar por bueno el mismo latido de antes; olvidar subir la versión.
 */
describe("actualizar el agente", () => {
  it("sólo un latido nuevo cuenta, y dice de qué versión a cuál", async () => {
    const { agentUpdateOutcome } = await import("@/lib/deploy");
    const before = { agentSeenAt: "2026-10-14T10:00:00Z", agentVersion: 4 };
    expect(agentUpdateOutcome(before, before)).toBeNull();
    expect(agentUpdateOutcome(before, { agentVersion: 5 })).toBeNull();
    expect(agentUpdateOutcome(before, { agentSeenAt: "2026-10-14T10:00:07Z", agentVersion: 5 })).toEqual({ from: 4, to: 5 });
    expect(agentUpdateOutcome({}, { agentSeenAt: "2026-10-14T10:00:07Z", agentVersion: 5 })).toEqual({ from: 0, to: 5 });
  });

  it("la app instala la versión de swarm-manage/VERSION", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { AGENT_VERSION_LATEST } = await import("@/lib/deploy");
    const version = Number(readFileSync(join(process.cwd(), "..", "swarm-manage", "VERSION"), "utf-8").trim());
    expect(AGENT_VERSION_LATEST).toBe(version);
  });
});

/**
 * Los build args del Dockerfile, cruzados con los secrets del servicio.
 * Mutantes: pasar a «los dos» uno que ya era del build; no añadir los que
 * faltan; añadir uno que ya estaba.
 */
describe("los build args del Dockerfile", () => {
  it("el de la app pasa a los dos, el que falta se añade, lo demás no se toca", async () => {
    const { mergeBuildArgs } = await import("@/lib/deploy");
    const rows = [
      { name: "DATABASE_URL", opRef: "op://a/b/db", usage: "runtime" as const },
      { name: "NEXT_PUBLIC_X", opRef: "op://a/b/x", usage: "build" as const },
      { name: "SESSION_SECRET", opRef: "op://a/b/s", usage: "runtime" as const },
    ];
    const out = mergeBuildArgs(rows, ["DATABASE_URL", "NEXT_PUBLIC_X", "MJ_APIKEY_PUBLIC"]);
    expect(out.rows).toEqual([
      { name: "DATABASE_URL", opRef: "op://a/b/db", usage: "both" },
      { name: "NEXT_PUBLIC_X", opRef: "op://a/b/x", usage: "build" },
      { name: "SESSION_SECRET", opRef: "op://a/b/s", usage: "runtime" },
      { name: "MJ_APIKEY_PUBLIC", opRef: "", usage: "build" },
    ]);
    expect([out.added, out.promoted]).toEqual([1, 1]);
  });
});
