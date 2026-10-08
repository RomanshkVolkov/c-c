import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Las cabeceras de la versión web (`web/security-headers.conf`), que sirve
 * nginx. Hasta W3 nada las vigilaba.
 *
 * Igual que la del escritorio (`desktop-csp.test.ts`): la CSP no da error,
 * sólo no carga, así que quitar una fuente rompe esa pantalla sin que nadie se
 * entere hasta que alguien la abre. Cada línea de abajo es un mutante.
 */
const conf = readFileSync(join(process.cwd(), "web/security-headers.conf"), "utf8");

function cabecera(nombre: string): string {
  const m = conf.match(new RegExp(`add_header ${nombre} "([^"]*)"`));
  return m?.[1] ?? "";
}

const csp = new Map(
  cabecera("Content-Security-Policy")
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .filter((p) => p[0])
    .map(([k, ...v]) => [k, v]),
);

describe("la CSP de la web", () => {
  it("sólo corre el código de la web", () => {
    expect(csp.get("script-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
  });

  // Sin esto la llamada desde el navegador no conecta: el motor abre la
  // señalización por wss y valida por https cuando algo falla.
  it("deja hablar con el SFU de las llamadas", () => {
    const connect = csp.get("connect-src") ?? [];
    expect(connect).toContain("'self'");
    expect(connect).toContain("wss://rtc.guz-studio.dev");
    expect(connect).toContain("https://rtc.guz-studio.dev");
  });

  // Y no deja hablar con cualquiera: un comodín aquí es una puerta para
  // sacar la sesión de la página.
  it("no abre connect-src a cualquiera", () => {
    for (const f of csp.get("connect-src") ?? []) {
      expect(f).not.toMatch(/^(\*|https?:|wss?:)$/);
    }
  });
});

describe("los permisos del navegador", () => {
  const permisos = cabecera("Permissions-Policy");
  // Micrófono, cámara y pantalla, para esta página y nadie más: es una
  // llamada. Sin ellos, el navegador ni pregunta.
  it.each(["camera", "microphone", "display-capture"])("%s, sólo para la propia web", (p) => {
    expect(permisos).toContain(`${p}=(self)`);
  });
});
