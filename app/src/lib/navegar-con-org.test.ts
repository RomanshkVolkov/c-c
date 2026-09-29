import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Los sitios que abren algo por su enlace van por `goInOrg`.
 *
 * Son los que pueden recibir un objeto de otra org: un resultado de búsqueda,
 * un aviso, un directo sin leer, una reunión que suena. Con un `navigate` a
 * pelo, el enlace se abre en la org que esté en pantalla y se pinta algo de A
 * dentro de B. Esta prueba lo busca en el texto, porque es exactamente la
 * línea que alguien escribirá sin pensar al añadir la siguiente fila.
 */

const PUERTAS: [string, RegExp][] = [
  ["components/NotificationsPanel.tsx", /\bnavigate\([^)]*\blink\b/],
  ["components/CommandPalette.tsx", /\bnavigate\([^)]*\blink\b/],
  ["pages/Overview.tsx", /\bnavigate\(`\/dm\?c=/],
  ["components/meetings/MeetingCall.tsx", /\bnavigate\(`\/chat\?space=/],
  ["components/voice/VoiceMini.tsx", /\bnavigate\(`\/chat\?space=/],
];

describe("abrir por su enlace", () => {
  for (const [fichero, aPelo] of PUERTAS) {
    it(`${fichero} va por goInOrg`, () => {
      const s = readFileSync(join(process.cwd(), "src", fichero), "utf8");
      expect(s).toMatch(/goInOrg\(/);
      const lineas = s.split("\n").filter((l) => aPelo.test(l) && !l.trim().startsWith("//"));
      expect(lineas).toEqual([]);
    });
  }
});
