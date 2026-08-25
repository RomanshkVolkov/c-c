import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Cuando **otra sesión** borra una tarea, la fila también tiene que irse.
 *
 * «My work» junta tareas de todas las listas, y la rama de eventos de tareas se
 * corta antes de hacer nada cuando el evento no es de la lista que estás
 * mirando —«no hay lista abierta», «es de otra lista»—. Esos cortes son buenos
 * para no recargar el tablero por cada tarjeta que alguien toca, pero dejarían
 * la fila borrada puesta: en «My work» casi nunca estás mirando la lista de la
 * que viene el evento.
 *
 * De ahí que el olvido vaya **antes** de esos cortes. Se comprueba leyendo el
 * fuente porque el orden es la regla: una prueba que sólo llamara al hook no
 * distinguiría «se quita» de «se quita cuando además estás en esa lista», que
 * es justo el fallo.
 */

const fuente = () =>
  readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("una tarea borrada en otra sesión", () => {
  it("se olvida de «My work»", () => {
    expect(fuente()).toContain("olvidar(p.taskId)");
  });

  it("y se olvida antes de descartar el evento por no ser de tu lista", () => {
    const s = fuente();
    const olvido = s.indexOf("olvidar(p.taskId)");
    const corte = s.indexOf("if (!store.activeListId) return;");
    expect(olvido).toBeGreaterThan(-1);
    expect(corte).toBeGreaterThan(-1);
    expect(olvido).toBeLessThan(corte);
  });

  // El evento trae el id; sin leerlo no habría nada que olvidar.
  it("leyendo el taskId que trae el evento", () => {
    expect(fuente()).toMatch(/taskId\?: string/);
  });
});
