import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import i18next from "i18next";

/**
 * Los plurales, y que no vuelvan cosidos a mano.
 *
 * Había catorce sitios con `member${n === 1 ? "" : "s"}` y tres con un `(s)` de
 * rendirse. En castellano no sirve ninguno de los dos: «1 espacio» y «2
 * espacios» no se diferencian en una ese, y hay idiomas con más de dos formas.
 *
 * Dos pruebas distintas: que las formas existan y digan cosas distintas, y que
 * nadie vuelva a escribir el ternario.
 */

const CUENTAS = [
  "members", "spaces", "reportsThisMonth", "tasks",
  "nodesReady", "issues", "heartbeats", "deletesTasks",
] as const;

describe("las formas del plural", () => {
  it.each(CUENTAS)("«%s» dice algo distinto en singular y en plural", (clave) => {
    for (const lng of ["en", "es"]) {
      const una = i18next.t(`common:count.${clave}` as never, { count: 1, lng });
      const varias = i18next.t(`common:count.${clave}` as never, { count: 4, lng });
      // Quitando el número, que ya los diferencia por sí solo: lo que tiene que
      // cambiar es la **palabra**.
      const sinNumero = (s: string) => s.replace(/\d+/g, "");
      expect(sinNumero(una as string)).not.toBe(sinNumero(varias as string));
    }
  });

  it.each(CUENTAS)("«%s» lleva el número dentro de la frase", (clave) => {
    for (const lng of ["en", "es"]) {
      expect(i18next.t(`common:count.${clave}` as never, { count: 7, lng })).toContain("7");
    }
  });

  // El cero va con la forma plural en los dos idiomas: «0 reportes», «0
  // reports». Es el caso que más se ve —una integración recién creada— y el que
  // un ternario `=== 1` acertaba por casualidad.
  it("el cero se dice en plural", () => {
    for (const lng of ["en", "es"]) {
      const cero = i18next.t("common:count.reportsThisMonth", { count: 0, lng });
      const varias = i18next.t("common:count.reportsThisMonth", { count: 4, lng });
      const sinNumero = (s: string) => s.replace(/\d+/g, "");
      expect(sinNumero(cero)).toBe(sinNumero(varias));
    }
  });
});

describe("y que no vuelvan a coserse a mano", () => {
  /**
   * Se mira el fuente porque la regla es sobre **cómo se escribe**: una prueba
   * de comportamiento no distingue un plural del catálogo de uno cosido con un
   * ternario que, en inglés, da el mismo texto.
   */
  const buscar = (patron: string, filtro = "") => {
    try {
      return execSync(
        `grep -rn --include=*.tsx --include=*.ts ${patron} src | grep -v '\\.test\\.'${filtro}`,
        { encoding: "utf-8" },
      ).trim();
    } catch {
      return ""; // grep sale con 1 cuando no encuentra nada
    }
  };

  it("ningún `? \"\" : \"s\"` suelto", () => {
    expect(buscar(`-e '? "" : "s"' -e '? "s" : ""'`)).toBe("");
  });

  /**
   * Pegado a una palabra —«task(s)», «node(s)»—, que es el idiom que se busca.
   *
   * Un «(s)» suelto encontraría todos los selectores de zustand, `(s) => s.algo`,
   * así que se pide una letra delante. Pero eso sigue casando con una llamada
   * cuyo argumento se llame `s` —`copy(s)`, `handleRevoke(s)`—, que es el mismo
   * texto exacto. Lo que las separa es lo que va **detrás**: una llamada vive
   * dentro de una expresión y le sigue `)`, `}`, `;` o `,`; el sustantivo vive dentro
   * de una frase y le sigue una comilla, un espacio o el final de la línea.
   */
  it("ningún «(s)» de rendirse", () => {
    expect(buscar(`-E '[a-z]\\(s\\)'`, ` | grep -vE '\\(s\\)[)};,]'`)).toBe("");
  });
});
