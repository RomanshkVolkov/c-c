import { describe, expect, it } from "vitest";
import { activo } from "./desde";

/**
 * La ventana de actividad, y por qué es de diez minutos.
 *
 * La marca se escribe como mucho una vez cada cinco (`TouchLastSeen`) y el
 * stream late cada 25 segundos. Con una ventana más corta el punto parpadearía
 * por el propio tope de escritura, no por la persona — que es la forma más
 * rápida de que un indicador se vuelva ruido y se deje de mirar.
 */
const haceMinutos = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe("quién está activo", () => {
  it("dentro de la ventana, sí", () => {
    expect(activo(haceMinutos(0))).toBe(true);
    // Nueve minutos: alguien que dio señales justo antes del último tope.
    expect(activo(haceMinutos(9))).toBe(true);
  });

  it("fuera de la ventana, no", () => {
    expect(activo(haceMinutos(11))).toBe(false);
    expect(activo(haceMinutos(60 * 24))).toBe(false);
  });

  it("sin marca, no — y sin reventar", () => {
    // Una cuenta que nunca ha entrado no trae el campo: es `omitempty`.
    expect(activo(undefined)).toBe(false);
    expect(activo(null)).toBe(false);
  });
});
