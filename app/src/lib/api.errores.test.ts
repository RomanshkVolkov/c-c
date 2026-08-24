import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Qué se lee de una respuesta con error, y qué se hace con ella.
 *
 * El servidor manda dos campos con dos oficios: `message` es la frase para leer
 * —«That list belongs to another organization»— y `error` la etiqueta para el
 * código —`inbox-other-org`—. Se estaba enseñando la etiqueta, así que un 409
 * perfectamente explicado llegaba a la pantalla como «Error: inbox-other-org».
 *
 * Lo otro que se fija aquí es la trampa que casi me llevo por delante:
 * `expired-token` viaja con `message: "Unauthorized"`. Si el texto que se
 * enseña y el que se compara fueran el mismo valor, empezar a mostrar la frase
 * habría dejado de reconocer el token caducado y **nadie volvería a renovar
 * sesión** — se cerraría sola, sin relación aparente con haber cambiado un
 * mensaje de error.
 */

const { setAuth, clearAuth } = vi.hoisted(() => ({ setAuth: vi.fn(), clearAuth: vi.fn() }));
const sesion = { current: { refreshToken: "un-refresh" } as Record<string, unknown> };

vi.mock("@/store/connection.store", () => ({
  useConnectionStore: { getState: () => ({ markFail: vi.fn(), markOk: vi.fn() }) },
}));
// `tryRefresh` vive dentro de `api.ts` y se apoya en este store, así que la
// renovación se prueba por lo que hace de verdad: pedir `/auth/refresh`.
vi.mock("@/store/auth.store", () => ({
  useAuthStore: {
    getState: () => ({ ...sesion.current, session: { id: "u-1" }, setAuth, clearAuth }),
  },
}));

const respuesta = (status: number, body: unknown) =>
  ({
    status,
    ok: status < 400,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response;

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAuth.mockReset();
  clearAuth.mockReset();
  sesion.current = { refreshToken: "un-refresh" };
});
afterEach(() => vi.unstubAllGlobals());

const { api } = await import("@/lib/api");

describe("el texto que llega a la pantalla", () => {
  it("es la frase, no la etiqueta del código", async () => {
    fetchMock.mockResolvedValue(
      respuesta(409, {
        success: false,
        message: "That list belongs to another organization.",
        error: "inbox-other-org",
      }),
    );
    await expect(api.get("/x")).rejects.toThrow("That list belongs to another organization.");
  });

  // Endpoints viejos que sólo mandan la etiqueta: enseñarla es mejor que un
  // «Request failed» que no dice nada.
  it("si no hay frase, se enseña la etiqueta", async () => {
    fetchMock.mockResolvedValue(respuesta(400, { success: false, error: "no-channel" }));
    await expect(api.get("/x")).rejects.toThrow("no-channel");
  });

  it("y si no hay ninguna de las dos, algo se dice", async () => {
    fetchMock.mockResolvedValue(respuesta(500, { success: false }));
    await expect(api.get("/x")).rejects.toThrow("Request failed");
  });
});

describe("el token caducado se sigue reconociendo", () => {
  // La comparación va contra `error`, no contra el texto que se enseña. Este es
  // el caso real: la frase dice «Unauthorized» y la etiqueta dice qué pasó.
  it("renueva la sesión y reintenta, aunque la frase diga otra cosa", async () => {
    fetchMock
      .mockResolvedValueOnce(
        respuesta(401, { success: false, message: "Unauthorized", error: "expired-token" }),
      )
      .mockResolvedValueOnce(
        respuesta(200, {
          success: true,
          data: { accessToken: "nuevo", refreshToken: "nuevo-refresh" },
        }),
      )
      .mockResolvedValueOnce(respuesta(200, { success: true, data: { ok: 1 } }));

    await expect(api.get("/x")).resolves.toEqual({ success: true, data: { ok: 1 } });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[1]).toContain("/api/v1/auth/refresh");
    expect(setAuth).toHaveBeenCalled();
  });

  it("y si la renovación falla, la sesión se acabó", async () => {
    fetchMock
      .mockResolvedValueOnce(
        respuesta(401, { success: false, message: "Unauthorized", error: "expired-token" }),
      )
      .mockResolvedValueOnce(respuesta(401, { success: false, error: "invalid-refresh" }));
    await expect(api.get("/x")).rejects.toThrow("session-expired");
    expect(clearAuth).toHaveBeenCalled();
  });

  // Un 401 que no es por caducidad no se reintenta: reintentar una credencial
  // que no vale es pedirle al servidor que la rechace dos veces.
  it("otro 401 no dispara la renovación", async () => {
    fetchMock.mockResolvedValue(
      respuesta(401, { success: false, message: "Unauthorized", error: "invalid-token" }),
    );
    await expect(api.get("/x")).rejects.toThrow("Unauthorized");
    // Una sola petición: no hubo intento de renovar.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setAuth).not.toHaveBeenCalled();
  });
});
