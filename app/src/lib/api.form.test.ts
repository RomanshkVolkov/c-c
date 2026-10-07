import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Una subida que recibe algo que no es JSON (el 404 en texto plano de una ruta
 * que el servidor aún no tiene) decía «SyntaxError: The string did not match
 * the expected pattern» (jose, 6-oct-2026). Ahora dice el código HTTP.
 * Mutante: volver a leer el JSON sin protección.
 */
const { api } = await import("./api");

afterEach(() => vi.unstubAllGlobals());

describe("una subida con una respuesta que no es JSON", () => {
  it("dice el código HTTP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("404 page not found", { status: 404 })));
    await expect(api.postForm("/api/v1/dm/c/attachments", new FormData())).rejects.toThrow("HTTP 404");
  });

  it("y una buena se lee igual que antes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { url: "/x" } }), { status: 201 })));
    await expect(api.postForm("/api/v1/dm/c/attachments", new FormData())).resolves.toMatchObject({ data: { url: "/x" } });
  });
});
