import { describe, expect, it } from "vitest";

import { sameVoice } from "@/lib/same-voice";

/**
 * Roturas que detecta: agrupar por autor solo (un mensaje de agente perdería
 * su cabecera, que es donde dice «vía agente»), o dejar de agrupar los
 * mensajes seguidos de la misma persona.
 */
describe("sameVoice", () => {
  it("pega los mensajes seguidos de la misma persona por el mismo sitio", () => {
    expect(sameVoice({ authorUserId: "u1" }, { authorUserId: "u1" })).toBe(true);
    expect(sameVoice({ authorUserId: "u1", via: "mcp" }, { authorUserId: "u1", via: "mcp" })).toBe(true);
  });
  it("no pega uno de agente bajo uno de la persona, ni al revés", () => {
    expect(sameVoice({ authorUserId: "u1" }, { authorUserId: "u1", via: "mcp" })).toBe(false);
    expect(sameVoice({ authorUserId: "u1", via: "mcp" }, { authorUserId: "u1", via: "" })).toBe(false);
  });
  it("no pega el primero ni los de otra persona", () => {
    expect(sameVoice(undefined, { authorUserId: "u1" })).toBe(false);
    expect(sameVoice({ authorUserId: "u2" }, { authorUserId: "u1" })).toBe(false);
  });
});
