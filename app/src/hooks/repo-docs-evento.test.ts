import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `repo-docs:changed`: un push cambió los .md de un repo. Tiene que tener su
 * rama y estar en la lista del `EventSource`: en un navegador un evento que
 * no se escucha por su nombre no llega nunca (docs/notifications.md §4.2).
 * Mutantes: quitarlo de la lista; la rama sin `refreshRepo`.
 */
const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("el evento repo-docs:changed", () => {
  it("refresca lo de ese repo", () => {
    const s = fuente();
    const rama = s.slice(s.indexOf('case "repo-docs:changed":'));
    expect(rama.slice(0, 400)).toContain("refreshRepo(");
  });

  it("y se escucha también en la web", () => {
    const s = fuente();
    const lista = s.slice(s.indexOf("for (const kind of ["), s.indexOf("es.addEventListener(kind"));
    expect(lista).toContain('"repo-docs:changed"');
  });
});
