import { describe, expect, it } from "vitest";

/**
 * Un aviso tiene que decir **de qué** habla.
 *
 * «Cambió el estado de un reporte» es cierto y no sirve: con tres reportes
 * abiertos no dice cuál, así que hay que abrir la app para averiguar si era el
 * que te importaba — que es exactamente lo que un aviso viene a evitar.
 *
 * La causa era que el cliente sólo recibía un identificador. El servidor manda
 * ahora el folio y el título en **todos** los eventos de ficha, igual que ya
 * hacía con el canal y el autor en el chat, y por lo mismo: la consola anunciaba
 * «un mensaje en un canal».
 */

// La de verdad, no una copia: una copia pasaría verde mientras la real se va
// por otro lado, que es el fallo que estas pruebas existen para evitar.
const { nombreDeFicha: nombreDe } = await import("@/hooks/use-report-events");

describe("cómo se nombra una ficha en un aviso", () => {
  it("el folio primero, que es lo que se cita", () => {
    expect(nombreDe({ folio: "portento-89", title: "No carga el panel" })).toBe(
      "portento-89 · No carga el panel",
    );
  });

  // Un evento de una ficha sin proyecto no tiene folio: el título solo sigue
  // sirviendo, y es mejor que un identificador.
  it("con sólo uno de los dos, ese", () => {
    expect(nombreDe({ title: "No carga el panel" })).toBe("No carga el panel");
    expect(nombreDe({ folio: "portento-89" })).toBe("portento-89");
  });

  /**
   * Sin nada que decir, cadena vacía — y quien llama pone el texto de reserva.
   *
   * Devolver « · » o «undefined · undefined» sería peor que el aviso genérico
   * que se venía a arreglar: un separador suelto no dice nada y encima parece
   * un fallo.
   */
  it("sin nada, nada — no un separador suelto", () => {
    expect(nombreDe({})).toBe("");
    expect(nombreDe({ folio: null, title: undefined })).toBe("");
    expect(nombreDe({ folio: "", title: "" })).toBe("");
  });

  // El servidor manda números en algunos campos; concatenarlos daría «89 ·».
  it("lo que no es texto no se cuela", () => {
    expect(nombreDe({ folio: 89 as never, title: "algo" })).toBe("algo");
  });
});
