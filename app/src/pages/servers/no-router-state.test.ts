import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ninguna pantalla de servidores vive del `state` del router.
 *
 * Así vivían todas hasta la R4: el servidor viajaba en `navigate(…, { state })`
 * y el `state` no sobrevive a recargar ni a un enlace, así que la pantalla
 * volvía al panel sin decir por qué. Ahora el servidor sale de la URL
 * (`useServer`) y el servicio de `?service=`. Volver a pasarlo por `state`
 * compila y funciona —hasta el primer F5—, así que lo vigila esto.
 */
const raiz = join(__dirname, "..", "..");
const ficheros = [
  ...readdirSync(join(raiz, "pages", "servers"))
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
    .map((f) => join("pages", "servers", f)),
  ...readdirSync(join(raiz, "components", "servers"))
    .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
    .map((f) => join("components", "servers", f)),
  "pages/ServerStats.tsx",
  "pages/StackSecrets.tsx",
  "pages/Dashboard.tsx",
  "pages/K8sHub.tsx",
];

describe("las pantallas de servidores no viven del state del router", () => {
  it.each(ficheros)("%s", (f) => {
    const src = readFileSync(join(raiz, f), "utf8");
    expect(src, "lee location.state").not.toMatch(/useLocation\(\)[\s\S]{0,40}\bstate\b|location\.state/);
    expect(src, "navega con state").not.toMatch(/navigate\([^;]*?\{\s*[^}]*\bstate\s*:/);
    expect(src, "un Link con state").not.toMatch(/<(Nav)?Link[^>]*\bstate=/);
  });

  it("la lista no está vacía (si cambia una carpeta, que se note)", () => {
    expect(ficheros.length).toBeGreaterThan(8);
  });
});
