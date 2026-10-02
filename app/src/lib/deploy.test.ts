import { describe, expect, it } from "vitest";
import { guessEnvironment, isSha, repoFromImage, shortRef, shortServiceName, ciNoticeStep, usesShortSha } from "./deploy";

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
