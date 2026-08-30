import { describe, expect, it } from "vitest";
import i18next from "i18next";

import {
  CATEGORY_LABEL_KEYS,
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
} from "@/types/report";
import type { MessageKey } from "@/lib/i18n";

/**
 * Cada identificador apunta a su propia palabra.
 *
 * El fallo que esto vigila no se parece a un fallo: una clave cruzada —`done`
 * apuntando a «Cerrada»— compila, pasa el control de catálogos, y deja la
 * interfaz llamando a las cosas por el nombre de otra. Nadie lo nota hasta que
 * alguien mueve una tarjeta y lee lo que no es.
 *
 * Y es fácil de provocar: son tres mapas de líneas casi idénticas, del tipo que
 * se copian y se pegan.
 */

/** Los mapas, con el trozo del catálogo que les corresponde. */
const MAPAS: [string, Record<string, MessageKey>, string][] = [
  ["estado", STATUS_LABEL_KEYS, "work:status"],
  ["categoría", CATEGORY_LABEL_KEYS, "work:category"],
  ["prioridad", PRIORITY_LABEL_KEYS, "work:priority"],
];

describe("las etiquetas de la taxonomía", () => {
  it.each(MAPAS)("cada %s apunta a su propia clave", (_nombre, mapa, prefijo) => {
    for (const [id, clave] of Object.entries(mapa)) {
      expect(clave).toBe(`${prefijo}.${id}`);
    }
  });

  // Dos identificadores compartiendo palabra es el mismo fallo visto de otra
  // forma: «En curso» saliendo en dos columnas distintas.
  it.each(MAPAS)("no hay dos %s con la misma clave", (_nombre, mapa) => {
    const claves = Object.values(mapa);
    expect(new Set(claves).size).toBe(claves.length);
  });

  // Y que existan de verdad: una clave bien formada pero ausente del catálogo
  // saldría cruda en pantalla.
  it.each(MAPAS)("todas las de %s están en los dos idiomas", (_nombre, mapa) => {
    for (const clave of Object.values(mapa)) {
      for (const lng of ["en", "es"]) {
        const texto = i18next.t(clave, { lng });
        expect(texto).not.toBe(clave);
        expect(texto.trim()).not.toBe("");
      }
    }
  });
});
