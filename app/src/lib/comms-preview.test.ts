import { describe, expect, it } from "vitest";

import { wasRead } from "@/components/chat/ReadTicks";
import { listTime, previewLine } from "@/lib/comms-preview";
import { horaCorta } from "@/lib/fechas";

/**
 * La fila de un canal o un directo, como en WhatsApp. Mutantes: firmar en un
 * directo; no decir «Tú»; enseñar el markdown; contar los días en UTC (corre
 * bajo tres zonas, `bun run test:timezones`); leído con la comparación al revés.
 */
const L = { you: "You", callEnded: "Call ended" };

describe("la línea de debajo del nombre", () => {
  it("en un canal, con quién lo dijo y en limpio", () => {
    expect(previewLine({ body: "**ojo** con [esto](https://x.y)", authorName: "Bea", mine: false }, L, true)).toBe(
      "Bea: ojo con esto",
    );
  });

  it("lo tuyo es «Tú», y en un directo el otro no se firma", () => {
    expect(previewLine({ body: "voy", authorName: "Ana", mine: true }, L, true)).toBe("You: voy");
    expect(previewLine({ body: "¿vienes?", authorName: "Bea", mine: false }, L, false)).toBe("¿vienes?");
  });

  it("una línea del sistema no la firma nadie, y una llamada se dice con palabras", () => {
    const call = "Call ended · 3 min — [details](cac:call/0f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8).";
    expect(previewLine({ body: call, kind: "system", authorName: "Ana", mine: false }, L, true)).toBe("Call ended");
    expect(previewLine({ body: "La grabación está lista", kind: "system", authorName: "Ana", mine: false }, L, true)).toBe(
      "La grabación está lista",
    );
  });
});

describe("la hora de la fila", () => {
  // A las 10:00 locales de un jueves, sea cual sea la zona en la que corre.
  const now = new Date(2026, 9, 15, 10, 0);
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

  it("hoy, la hora; ayer, «ayer», aunque fuera a las 23:59", () => {
    expect(listTime(at(15, 0, 5), now, "es-MX", "Ayer")).toBe(horaCorta(at(15, 0, 5)));
    expect(listTime(at(14, 23, 59), now, "es-MX", "Ayer")).toBe("Ayer");
  });

  it("esta semana, el día; antes, la fecha", () => {
    expect(listTime(at(12, 9), now, "en-US", "Yesterday")).toBe("Mon");
    expect(listTime(at(1, 9), now, "en-US", "Yesterday")).toBe("10/1/26");
    expect(listTime("no es fecha", now, "en-US", "Yesterday")).toBe("");
  });
});

describe("leído", () => {
  it("lo escrito antes de la marca del otro, y sólo eso", () => {
    expect(wasRead("2026-10-15T10:00:00Z", "2026-10-15T10:00:05Z")).toBe(true);
    expect(wasRead("2026-10-15T10:00:10Z", "2026-10-15T10:00:05Z")).toBe(false);
    expect(wasRead("2026-10-15T10:00:00Z", null)).toBe(false);
  });
});
