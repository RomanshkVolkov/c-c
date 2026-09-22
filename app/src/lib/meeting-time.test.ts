import { describe, expect, it } from "vitest";
import i18next from "i18next";

import { readableWeekdays, dualTime, readableTime, readableRule } from "@/lib/meeting-time";
import { NAMESPACES } from "@/lib/i18n";

/**
 * La misma hora, dicha en dos zonas.
 *
 * Todas las pruebas fijan **las dos** zonas —la de la reunión y la de quien
 * mira, con `timeZone` explícito— porque si no dependerían de la máquina donde
 * corran y pasarían aquí y fallarían en el CI, o al revés.
 *
 * `dualTime` sin `timeZone` para el lado local usa la zona del sistema, así que
 * lo que se comprueba aquí es la parte de la reunión y la relación entre las
 * dos, no un literal de la hora local.
 */

// Las 15:00Z de un día de agosto: 09:00 en CDMX, 17:00 en Madrid.
const INSTANT = "2026-08-25T15:00:00Z";

/**
 * La hora como número, venga en formato de 12 o de 24.
 *
 * El ayudante formatea con la configuración regional de quien mira —igual que
 * el resto de la app— así que el mismo instante sale «17:00» o «05:00 PM» según
 * la máquina. Afirmar el literal haría que estas pruebas pasaran aquí y
 * fallaran en el CI. Lo que importa es **qué hora es**, no cómo se escribe.
 */
const hourOf = (text: string): number => {
  // El AM/PM de **esta** hora, no el primero que haya en el texto: en
  // «09:00 AM CST · 03:00 PM UTC» el PM de la segunda convertía la primera en
  // las 21. Sólo se ve cuando quien mira no está en la zona de la reunión, así
  // que en CDMX —donde corre `bun run test`— no lo caza nada: lo guarda
  // `bun run test:timezones`, que muta y muere bajo UTC.
  const m = text.match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  if (!m) return -1;
  let h = Number(m[1]);
  const suffix = m[3]?.toUpperCase();
  if (suffix === "PM" && h !== 12) h += 12;
  if (suffix === "AM" && h === 12) h = 0;
  return h;
};

describe("la hora en la zona de la reunión", () => {
  it("la dice en la zona que se le pide, no en la del que mira", () => {
    expect(hourOf(dualTime(INSTANT, "America/Mexico_City").there)).toBe(9);
  });

  it("y con otra zona da otra hora, del mismo instante", () => {
    expect(hourOf(dualTime(INSTANT, "Europe/Madrid").there)).toBe(17);
  });

  // Lo que distingue una de otra cuando las dos se pintan juntas.
  it("lleva el nombre de la zona, para saber cuál es cuál", () => {
    const { there } = dualTime(INSTANT, "America/Mexico_City");
    expect(there.replace(/[\d:]|AM|PM/gi, "").trim().length).toBeGreaterThan(0);
  });

  // El día del cambio de horario. Restando desfases a mano esto falla; usando
  // el mismo instante formateado dos veces, no.
  it("respeta el horario de verano de cada zona", () => {
    // 13:00Z del 9 de marzo de 2026: Nueva York ya cambió (EDT, -4) → 09:00.
    expect(hourOf(dualTime("2026-03-09T13:00:00Z", "America/New_York").there)).toBe(9);
    // El mismo día, Madrid aún no ha cambiado (CET, +1) → 14:00.
    expect(hourOf(dualTime("2026-03-09T13:00:00Z", "Europe/Madrid").there)).toBe(14);
  });

  // Repetir la misma hora dos veces sólo sería ruido.
  it("avisa cuando las dos coinciden", () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(dualTime(INSTANT, local).sameZone).toBe(true);
  });

  it("y cuando no, no", () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const other = local === "Asia/Tokyo" ? "Europe/Madrid" : "Asia/Tokyo";
    expect(dualTime(INSTANT, other).sameZone).toBe(false);
  });

  // Una zona mal escrita no puede tumbar la pantalla entera: `Intl` lanza con
  // un nombre desconocido, y aquí se cae de pie enseñando sólo la hora local.
  it("una zona que no existe no rompe nada", () => {
    const { there, here } = dualTime(INSTANT, "Marte/Olympus");
    expect(there).toBe("");
    expect(here).not.toBe("");
  });

  it("y una fecha ilegible tampoco", () => {
    expect(dualTime("no es una fecha", "Europe/Madrid").here).toBe("");
  });
});

describe("la línea de una hora", () => {
  it("junta las dos con un separador", () => {
    const text = readableTime(INSTANT, "America/Mexico_City");
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local === "America/Mexico_City") {
      expect(text).not.toContain("·");
    } else {
      expect(text).toContain("·");
      expect(hourOf(text)).toBe(9);
    }
  });
});

describe("los días de la semana", () => {
  it("se leen con nombre", () => {
    expect(readableWeekdays("1,3,5")).toBe("Mon, Wed, Fri");
  });

  // El domingo es el 0 pero nadie empieza la semana nombrándolo.
  it("el domingo va al final, no al principio", () => {
    expect(readableWeekdays("0,1")).toBe("Mon, Sun");
  });

  it("la basura se ignora en vez de romper", () => {
    expect(readableWeekdays("1,x,9,3")).toBe("Mon, Wed");
    expect(readableWeekdays(undefined)).toBe("");
  });

  /**
   * Los nombres salen de `Intl`, y ésta es la prueba de que salen de ahí y no
   * de una tabla inglesa: en castellano el lunes no se llama «Mon». Se compara
   * contra el inglés en vez de contra un literal porque los nombres cortos los
   * fija la plataforma —«lun», «lun.»— y clavarlos aquí sería una prueba de la
   * versión de ICU, no del código.
   */
  it("y en castellano no son los de inglés", () => {
    expect(readableWeekdays("1,3", "es")).not.toBe(readableWeekdays("1,3", "en"));
  });

  // El orden es del código, no del idioma: si alguien se lleva la ordenación
  // dentro del formateador, esto lo caza.
  it("el orden de la semana se respeta en los dos idiomas", () => {
    expect(readableWeekdays("0,1", "es").indexOf(readableWeekdays("1", "es"))).toBe(0);
  });
});

describe("la regla en una línea", () => {
  // La `t` de verdad, con el catálogo cargado por `test-setup.ts`: una falsa
  // que devolviera la clave probaría el armazón y no las frases.
  const t = i18next.getFixedT(null, NAMESPACES) as never;
  const tEs = i18next.getFixedT("es", NAMESPACES) as never;

  it("la diaria", () => {
    expect(readableRule({ freq: "daily", interval: 1 }, t)).toBe("Daily");
  });

  it("la semanal con sus días", () => {
    expect(readableRule({ freq: "weekly", interval: 1, weekdays: "1,3" }, t)).toBe(
      "Weekly · Mon, Wed",
    );
  });

  it("la quincenal se distingue de la semanal", () => {
    const q = readableRule({ freq: "weekly", interval: 2, weekdays: "1" }, t);
    expect(q).toContain("2");
    expect(q).not.toBe("Weekly · Mon");
  });

  it("la mensual dice qué día", () => {
    expect(readableRule({ freq: "monthly", interval: 1, monthDay: 15 }, t)).toBe(
      "Monthly · day 15",
    );
  });

  // Lo que no sobrevivía a la concatenación: en castellano el número y el
  // sustantivo no caen donde caían, y el intervalo 1 no se dice «cada 1».
  it("en castellano dice la frase entera, no las palabras sueltas", () => {
    expect(readableRule({ freq: "weekly", interval: 1 }, tEs, "es")).toBe("Semanal");
    expect(readableRule({ freq: "weekly", interval: 2 }, tEs, "es")).toBe("Cada 2 semanas");
    expect(readableRule({ freq: "monthly", interval: 1, monthDay: 15 }, tEs, "es")).toBe(
      "Mensual · el día 15",
    );
  });

  // El idioma del texto y el de los días son el mismo argumento o no lo son:
  // una regla medio traducida es el fallo característico de esto.
  it("los días de la regla van en el idioma de la regla", () => {
    const rule = readableRule({ freq: "weekly", interval: 1, weekdays: "1,3" }, tEs, "es");
    expect(rule).toContain(readableWeekdays("1,3", "es"));
    expect(rule).not.toContain("Mon");
  });

  // Una frecuencia que esta versión no conoce no puede dejar la insignia vacía.
  it("una frecuencia desconocida se enseña tal cual", () => {
    expect(readableRule({ freq: "hourly" }, t)).toBe("hourly");
  });
});
