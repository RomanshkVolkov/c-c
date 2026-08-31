import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ningún hook después de un `return` temprano.
 *
 * Es la regla más vieja de React y la que peor falla: el componente sale con
 * cuatro hooks por un camino y con cinco por el otro, React lleva la cuenta por
 * **posición**, y en cuanto cambia la condición lanza «rendered more hooks than
 * during the previous render» y se cae la pantalla entera. No hay error de
 * compilación, no hay aviso, y en desarrollo puede no verse nunca — depende de
 * que la condición cambie mientras el componente está montado.
 *
 * Pasó de verdad en la v1.6.59, dos veces, y por la misma causa: el pase de
 * traducción metió `useT()` con un script y en dos sitios cayó debajo del
 * corte. `VozEnCurso` se caía al entrar alguien a un canal de voz; la campana,
 * al pasar una conversación de un mensaje a dos.
 *
 * **Esto es un parche y conviene decirlo.** Lo que caza esta clase de fallo es
 * `react-hooks/rules-of-hooks`, y este proyecto **no tiene linter** — ni eslint
 * en las dependencias. Esta prueba cubre el caso concreto que nos mordió, con
 * una heurística de indentación que no entiende de ámbitos; el linter entiende
 * el árbol y caza además los hooks dentro de un `if`, de un bucle o de un
 * callback. Ver la tarjeta del tablero.
 */
describe("el orden de los hooks", () => {
  const RAIZ = join(process.cwd(), "src");

  function fuentes(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const ruta = join(dir, e.name);
      if (e.isDirectory()) return fuentes(ruta);
      if (!/\.tsx$/.test(e.name) || e.name.includes(".test.")) return [];
      return [ruta];
    });
  }

  // A dos espacios: el cuerpo del componente y no el de un callback anidado.
  // Es tosco a propósito — un ámbito más profundo lo pinta más adentro, así que
  // el error cae del lado de no avisar, que es el correcto para un guardián.
  const RETORNO = /^ {2}(if \(.*\) )?return[ ;(]/;
  const HOOK = /^ {2}(const .*= )?use[A-Z]\w*\(/;
  const FUNCION = /^(export default |export )?function \w+|^const \w+ = (forwardRef|memo)/;

  it("ninguno se llama después de un return temprano", () => {
    const fallos: string[] = [];
    for (const fichero of fuentes(RAIZ)) {
      let retorno: number | null = null;
      readFileSync(fichero, "utf-8")
        .split("\n")
        .forEach((linea, i) => {
          if (FUNCION.test(linea)) retorno = null;
          if (RETORNO.test(linea)) retorno = i + 1;
          if (HOOK.test(linea) && retorno !== null) {
            fallos.push(
              `${fichero.replace(RAIZ, "src")}:${i + 1} — hook tras el return de la línea ${retorno}`,
            );
            retorno = null;
          }
        });
    }
    expect(fallos).toEqual([]);
  });
});
