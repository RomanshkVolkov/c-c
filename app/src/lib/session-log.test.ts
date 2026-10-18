import { describe, expect, it } from "vitest";

import { tokenId8 } from "@/lib/session-log";

const jwt = (payload: object) => `h.${btoa(JSON.stringify(payload)).replace(/=+$/, "")}.firma`;

/**
 * El diario de #175 sólo apunta los 8 primeros caracteres del id del token,
 * nunca el token. Mutantes: devolver el token entero; devolver el id entero.
 */
describe("el id corto de un token", () => {
  it("son los 8 primeros del token_id y nada más", () => {
    const t = jwt({ token_id: "3e4c736d-aaaa-bbbb-cccc-dddddddddddd", user_id: "u" });
    expect(tokenId8(t)).toBe("3e4c736d");
    expect(tokenId8(t)).not.toContain("firma");
    expect(tokenId8(null)).toBe("-");
    expect(tokenId8("basura")).toBe("?");
  });
});
