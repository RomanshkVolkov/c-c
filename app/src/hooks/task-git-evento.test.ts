import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `task:git`: una PR, una rama o un commit se enlazó a una tarea.
 *
 * Tiene que hacer lo mismo que un comentario —refrescar el tablero en pantalla
 * (el chip de la tarjeta) y la tarea abierta (el panel)—, y tiene que estar en
 * la lista del `EventSource`: en un navegador, un evento que no se escucha por
 * su nombre no llega nunca (docs/notifications.md §4.2). Se lee el fuente, como
 * en `task-delete-remoto.test.ts`, porque lo que importa es en qué rama cae.
 */

const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("el evento task:git", () => {
  it("cae en la misma rama que un comentario", () => {
    const s = fuente();
    const rama = s.slice(s.indexOf('case "task:new":'), s.indexOf("store.refreshBoard();"));
    expect(rama).toContain('case "task:comment":');
    expect(rama).toContain('case "task:git":');
  });

  it("y se escucha también en la web", () => {
    const s = fuente();
    const lista = s.slice(s.indexOf("for (const kind of ["), s.indexOf("es.addEventListener(kind"));
    expect(lista).toContain('"task:git"');
  });
});
