import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * La ventana no puede quedarse con los ficheros que se le arrastran.
 *
 * Con `dragDropEnabled` en true —que es el valor por defecto— el arrastre lo
 * captura el sistema y el webview **nunca** recibe el evento HTML5. El efecto no
 * es que falle un sitio: es que no funciona **ninguno**, y todos fallan igual,
 * en silencio y sin error. Así estuvieron el compositor del chat, el de los
 * directos y DevTools → Images, cada uno con su código de arrastre correcto.
 *
 * Se comprueba aquí porque es un fichero de configuración: nadie lo mira, se
 * regenera al añadir una ventana o al actualizar Tauri, y el valor por defecto
 * es justamente el que rompe.
 */
describe("la ventana", () => {
  it("deja que el arrastre de ficheros llegue a la app", () => {
    const conf = JSON.parse(
      readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
    );
    const ventanas: { dragDropEnabled?: boolean }[] = conf.app?.windows ?? [];
    expect(ventanas.length).toBeGreaterThan(0);
    for (const v of ventanas) {
      expect(v.dragDropEnabled).toBe(false);
    }
  });
});
