import { describe, expect, it } from "vitest";

import { viaMediaScheme } from "./media";

/**
 * El escritorio carga los adjuntos por `cacmedia://`, salvo servido por Vite
 * en desarrollo, donde WebKitGTK lo bloquea desde `http://localhost:1420` y va
 * como la web (con el pase). La web, nunca por el esquema. Mutantes: decidir
 * por el protocolo (rompería Windows instalado) o ignorar el modo.
 */
describe("por dónde se cargan los adjuntos", () => {
  it("la app instalada, por su esquema; en desarrollo y en la web, con el pase", () => {
    expect(viaMediaScheme(true, "production")).toBe(true);
    expect(viaMediaScheme(true, "development")).toBe(false);
    expect(viaMediaScheme(false, "production")).toBe(false);
  });
});
