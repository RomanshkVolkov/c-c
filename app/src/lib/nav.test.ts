import { describe, expect, it } from "vitest";

import { MODULES, moduleHome, moduleOf, visibleModules } from "@/lib/nav";

/**
 * Qué módulo del riel manda en cada ruta.
 *
 * Es lo que decide qué panel ves y qué icono va marcado: una ruta mal
 * asignada deja el panel de otro módulo delante de la pantalla, y entonces
 * el «dónde estoy» del sidebar miente. Mutantes: `/notes` a Comunicación;
 * `startsWith` a secas (`/dmx` caería en Directos); quitar el filtro de
 * invitado.
 */
describe("moduleOf", () => {
  it.each([
    ["/my-work", "work"],
    ["/overview", "work"],
    ["/tasks", "work"],
    ["/notes", "work"],
    ["/notes/abc", "work"],
    ["/docs", "docs"],
    ["/chat", "comms"],
    ["/dm", "comms"],
    ["/call/inv-1", "comms"],
    ["/dashboard", "platform"],
    ["/servers/abc/services", "platform"],
    ["/activity", "platform"],
    ["/diagnostics", "platform"],
    ["/users", "platform"],
    ["/devtools/image", "platform"],
  ])("%s → %s", (path, module) => {
    expect(moduleOf(path)).toBe(module);
  });

  it.each(["/organization", "/invitations", "/profile", "/login", "/"])(
    "%s no es de ningún módulo: el panel se queda con el último",
    (path) => {
      expect(moduleOf(path)).toBeNull();
    },
  );

  it("por prefijo entero, no por las primeras letras", () => {
    expect(moduleOf("/dmx")).toBeNull();
    expect(moduleOf("/docsy")).toBeNull();
  });
});

describe("visibleModules", () => {
  it("con sesión, los cuatro y en su orden", () => {
    expect(visibleModules({ authed: true }).map((m) => m.key)).toEqual(["work", "docs", "comms", "platform"]);
  });

  it("sin sesión, sólo Plataforma: las herramientas son lo único que funciona sin servidor", () => {
    expect(visibleModules({ authed: false }).map((m) => m.key)).toEqual(["platform"]);
  });
});

describe("moduleHome", () => {
  const platform = MODULES.find((m) => m.key === "platform")!;

  it("en la web Plataforma abre Actividad: Servidores no existe en ese build", () => {
    expect(moduleHome(platform, true)).toBe("/activity");
    expect(moduleHome(platform, false)).toBe("/dashboard");
  });
});
