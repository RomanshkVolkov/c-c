import { describe, expect, it } from "vitest";

/**
 * "When was this person last around", in the words somebody would use.
 *
 * An account that has never been used says so. An empty cell reads as missing
 * data — as if we failed to look — when it is a fact about the account.
 */

// La función es local a la pantalla; se comprueba a través de su contrato, que
// es lo que la tabla muestra.
function desde(iso?: string | null): string {
  if (!iso) return "never";
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 2) return "now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  return `${d} d ago`;
}

const haceMin = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe("la columna de actividad", () => {
  it("dice «never» cuando la cuenta no se ha usado", () => {
    expect(desde(null)).toBe("never");
    expect(desde(undefined)).toBe("never");
  });

  it("dice «now» dentro del primer par de minutos", () => {
    expect(desde(haceMin(0))).toBe("now");
  });

  it("y escala a minutos, horas y días", () => {
    expect(desde(haceMin(12))).toBe("12 min ago");
    expect(desde(haceMin(150))).toBe("2 h ago");
    expect(desde(haceMin(60 * 24 + 5))).toBe("yesterday");
    expect(desde(haceMin(60 * 24 * 3))).toBe("3 d ago");
  });
});
