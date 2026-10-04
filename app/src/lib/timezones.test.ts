import { describe, expect, it } from "vitest";
import { hourIn, isZone, wallTimeToday, zoneCity, zoneLabel, zoneOffset } from "./timezones";

/**
 * Las zonas como las dice una persona. Corre bajo las tres zonas de
 * `test:timezones`: nada de aquí puede depender de la de la máquina.
 */
describe("zonas horarias", () => {
  it("una zona se dice por su ciudad", () => {
    expect(zoneCity("America/Cancun")).toBe("Cancun");
    expect(zoneCity("America/Mexico_City")).toBe("Mexico City");
    expect(zoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
  });

  it("el desfase es el de ese día, con signo menos de verdad", () => {
    const enero = new Date("2026-01-15T12:00:00Z");
    expect(zoneOffset("America/Cancun", enero)).toBe("UTC−5");
    expect(zoneOffset("America/Mexico_City", enero)).toBe("UTC−6");
    expect(zoneOffset("Asia/Kolkata", enero)).toBe("UTC+5:30");
    expect(zoneOffset("UTC", enero)).toBe("UTC");
    // Madrid cambia con el verano: el mismo nombre, otro desfase.
    expect(zoneOffset("Europe/Madrid", enero)).toBe("UTC+1");
    expect(zoneOffset("Europe/Madrid", new Date("2026-07-15T12:00:00Z"))).toBe("UTC+2");
    expect(zoneLabel("America/Cancun", enero)).toBe("Cancun (UTC−5)");
  });

  it("una zona inventada no se acepta", () => {
    expect(isZone("America/Cancun")).toBe(true);
    expect(isZone("America/Cancunn")).toBe(false);
    expect(isZone("")).toBe(false);
  });

  // El caso de jose: 9:30 en Cancún es 8:30 en Querétaro (Mexico City).
  it("las 9:30 de Cancún son las 8:30 de Ciudad de México", () => {
    const at = wallTimeToday("09:30", "America/Cancun", new Date("2026-10-05T15:00:00Z"));
    expect(at?.toISOString()).toBe("2026-10-05T14:30:00.000Z");
    expect(hourIn(at!, "America/Mexico_City")).toMatch(/0?8:30/);
    expect(hourIn(at!, "America/Cancun")).toMatch(/0?9:30/);
  });

  // El día del cambio de hora, la hora pedida es la de después del cambio.
  it("el día que Madrid cambia al verano, las 9:00 son las 7:00 UTC", () => {
    const at = wallTimeToday("09:00", "Europe/Madrid", new Date("2026-03-29T12:00:00Z"));
    expect(at?.toISOString()).toBe("2026-03-29T07:00:00.000Z");
  });

  it("una hora que no es hora no da instante", () => {
    expect(wallTimeToday("9h30", "America/Cancun")).toBeNull();
    expect(wallTimeToday("09:30", "Mars/Olympus")).toBeNull();
  });
});
