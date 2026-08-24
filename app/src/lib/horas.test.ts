import { describe, expect, it } from "vitest";
import { diasLegibles, horaDual, horaLegible, reglaLegible } from "@/lib/horas";

/**
 * La misma hora, dicha en dos zonas.
 *
 * Todas las pruebas fijan **las dos** zonas —la de la reunión y la de quien
 * mira, con `timeZone` explícito— porque si no dependerían de la máquina donde
 * corran y pasarían aquí y fallarían en el CI, o al revés.
 *
 * `horaDual` sin `timeZone` para el lado local usa la zona del sistema, así que
 * lo que se comprueba aquí es la parte de la reunión y la relación entre las
 * dos, no un literal de la hora local.
 */

// Las 15:00Z de un día de agosto: 09:00 en CDMX, 17:00 en Madrid.
const INSTANTE = "2026-08-25T15:00:00Z";

/**
 * La hora como número, venga en formato de 12 o de 24.
 *
 * El ayudante formatea con la configuración regional de quien mira —igual que
 * el resto de la app— así que el mismo instante sale «17:00» o «05:00 PM» según
 * la máquina. Afirmar el literal haría que estas pruebas pasaran aquí y
 * fallaran en el CI. Lo que importa es **qué hora es**, no cómo se escribe.
 */
const enPunto = (texto: string): number => {
  const m = texto.match(/(\d{1,2}):(\d{2})/);
  if (!m) return -1;
  let h = Number(m[1]);
  if (/PM/i.test(texto) && h !== 12) h += 12;
  if (/AM/i.test(texto) && h === 12) h = 0;
  return h;
};

describe("la hora en la zona de la reunión", () => {
  it("la dice en la zona que se le pide, no en la del que mira", () => {
    expect(enPunto(horaDual(INSTANTE, "America/Mexico_City").alla)).toBe(9);
  });

  it("y con otra zona da otra hora, del mismo instante", () => {
    expect(enPunto(horaDual(INSTANTE, "Europe/Madrid").alla)).toBe(17);
  });

  // Lo que distingue una de otra cuando las dos se pintan juntas.
  it("lleva el nombre de la zona, para saber cuál es cuál", () => {
    const { alla } = horaDual(INSTANTE, "America/Mexico_City");
    expect(alla.replace(/[\d:]|AM|PM/gi, "").trim().length).toBeGreaterThan(0);
  });

  // El día del cambio de horario. Restando desfases a mano esto falla; usando
  // el mismo instante formateado dos veces, no.
  it("respeta el horario de verano de cada zona", () => {
    // 13:00Z del 9 de marzo de 2026: Nueva York ya cambió (EDT, -4) → 09:00.
    expect(enPunto(horaDual("2026-03-09T13:00:00Z", "America/New_York").alla)).toBe(9);
    // El mismo día, Madrid aún no ha cambiado (CET, +1) → 14:00.
    expect(enPunto(horaDual("2026-03-09T13:00:00Z", "Europe/Madrid").alla)).toBe(14);
  });

  // Repetir la misma hora dos veces sólo sería ruido.
  it("avisa cuando las dos coinciden", () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(horaDual(INSTANTE, local).mismaZona).toBe(true);
  });

  it("y cuando no, no", () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const otra = local === "Asia/Tokyo" ? "Europe/Madrid" : "Asia/Tokyo";
    expect(horaDual(INSTANTE, otra).mismaZona).toBe(false);
  });

  // Una zona mal escrita no puede tumbar la pantalla entera: `Intl` lanza con
  // un nombre desconocido, y aquí se cae de pie enseñando sólo la hora local.
  it("una zona que no existe no rompe nada", () => {
    const { alla, aqui } = horaDual(INSTANTE, "Marte/Olympus");
    expect(alla).toBe("");
    expect(aqui).not.toBe("");
  });

  it("y una fecha ilegible tampoco", () => {
    expect(horaDual("no es una fecha", "Europe/Madrid").aqui).toBe("");
  });
});

describe("la línea de una hora", () => {
  it("junta las dos con un separador", () => {
    const texto = horaLegible(INSTANTE, "America/Mexico_City");
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local === "America/Mexico_City") {
      expect(texto).not.toContain("·");
    } else {
      expect(texto).toContain("·");
      expect(enPunto(texto)).toBe(9);
    }
  });
});

describe("los días de la semana", () => {
  it("se leen con nombre", () => {
    expect(diasLegibles("1,3,5")).toBe("Mon, Wed, Fri");
  });

  // El domingo es el 0 pero nadie empieza la semana nombrándolo.
  it("el domingo va al final, no al principio", () => {
    expect(diasLegibles("0,1")).toBe("Mon, Sun");
  });

  it("la basura se ignora en vez de romper", () => {
    expect(diasLegibles("1,x,9,3")).toBe("Mon, Wed");
    expect(diasLegibles(undefined)).toBe("");
  });
});

describe("la regla en una línea", () => {
  it("la diaria", () => {
    expect(reglaLegible({ freq: "daily", interval: 1 })).toBe("Daily");
  });

  it("la semanal con sus días", () => {
    expect(reglaLegible({ freq: "weekly", interval: 1, weekdays: "1,3" })).toBe(
      "Weekly · Mon, Wed",
    );
  });

  it("la quincenal se distingue de la semanal", () => {
    const q = reglaLegible({ freq: "weekly", interval: 2, weekdays: "1" });
    expect(q).toContain("2");
    expect(q).not.toBe("Weekly · Mon");
  });

  it("la mensual dice qué día", () => {
    expect(reglaLegible({ freq: "monthly", interval: 1, monthDay: 15 })).toBe("Monthly · day 15");
  });
});
