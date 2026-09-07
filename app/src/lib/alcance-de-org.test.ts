import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Pedir tareas o reportes sin decir de qué organización.
 *
 * El servidor hace lo correcto cuando falta `orgId`: contesta con **todas** las
 * organizaciones a las que perteneces. Ése es su valor por defecto y está bien
 * para el tablero de reportes de un superadmin.
 *
 * En una pantalla acotada por el selector de arriba, es un fallo — y de los que
 * no se ven: el resumen enseñaba tareas de varias organizaciones y «ver más»
 * llevaba a «Mi trabajo», que sí acota, así que desaparecían al pulsar. Una
 * pantalla que enseña algo y lo esconde al ampliarla no se lee como un filtro:
 * se lee como que se han perdido.
 *
 * Se comprueba como guardián y no con una prueba de la pantalla porque el fallo
 * es de una **clase**: un parámetro olvidado en una plantilla de cadena. Ya pasó
 * una vez, en una tarjeta que además existía bien escrita en otro fichero.
 */

const RAIZ = resolve(__dirname, "..");

/** Las rutas que el servidor devuelve sin acotar si nadie se lo pide. */
const SIN_ACOTAR = /\/api\/v1\/(tasks|reports)\/\?/;

function ficheros(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) ficheros(p, out);
    else if (/\.tsx?$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}

describe("las listas que cruzan organizaciones", () => {
  it("nadie las pide sin decir de cuál", () => {
    const culpables: string[] = [];
    for (const f of ficheros(RAIZ)) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((linea, i) => {
          if (!SIN_ACOTAR.test(linea)) return;
          // `orgId` en la misma línea, o construido justo antes y metido en la
          // consulta: las dos formas que usa este proyecto.
          if (/orgId/.test(linea) || /\$\{(qs|partes|org)\b/.test(linea)) return;
          culpables.push(`${f.replace(RAIZ, "src")}:${i + 1}`);
        });
    }
    expect(culpables).toEqual([]);
  });
});
