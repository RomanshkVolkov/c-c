import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lo que la pantalla de reuniones le manda al servidor.
 *
 * Dos cosas que importan y no se ven pintando: que editar mande **sólo lo que
 * cambió** —el servidor deja como está lo que no se menciona, así que renombrar
 * una reunión no puede moverle la hora— y que la lista de destinatarios viaje
 * como **excluidos**, que es lo que hace que quien entre mañana en la
 * organización quede convocado sin que nadie se acuerde de él.
 */

const { get, post, patch, put, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: { get, post, patch, put, delete: del, postForm: vi.fn() },
}));

const { useMeetingsStore } = await import("@/store/meetings.store");

beforeEach(() => {
  [get, post, patch, put, del].forEach((f) => f.mockClear());
  get.mockResolvedValue({ success: true, data: [] });
  post.mockResolvedValue({ success: true });
  patch.mockResolvedValue({ success: true });
  put.mockResolvedValue({ success: true });
  del.mockResolvedValue({ success: true });
});

describe("crear una reunión", () => {
  it("manda la hora de pared y su zona, no un instante", async () => {
    await useMeetingsStore.getState().create("org-1", {
      title: "Daily",
      wallTime: "09:00",
      timezone: "America/Mexico_City",
      freq: "weekly",
      weekdays: "1,3,5",
    });
    const [url, cuerpo] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("/api/v1/organizations/org-1/meetings/");
    expect(cuerpo.wallTime).toBe("09:00");
    expect(cuerpo.timezone).toBe("America/Mexico_City");
    // Ningún campo con pinta de instante: comprimir la recurrencia a UTC es el
    // fallo que este modelo existe para evitar.
    expect(cuerpo).not.toHaveProperty("nextFireAt");
    expect(cuerpo).not.toHaveProperty("firesAt");
  });

  it("y relee la agenda para que aparezca", async () => {
    await useMeetingsStore.getState().create("org-1", {
      title: "Daily", wallTime: "09:00", timezone: "UTC", freq: "daily",
    });
    expect(get).toHaveBeenCalledWith("/api/v1/organizations/org-1/meetings/");
  });
});

describe("editar una reunión", () => {
  // Lo que hacía el PATCH viejo de los canales: mandar el formulario entero y
  // borrar por omisión. Aquí no puede pasar porque no se manda entero.
  it("manda sólo lo que cambió", async () => {
    await useMeetingsStore.getState().update("m-1", "org-1", { title: "Otro nombre" });
    const [url, cuerpo] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("/api/v1/meetings/m-1/");
    expect(cuerpo).toEqual({ title: "Otro nombre" });
  });

  it("pausar es un cambio como otro", async () => {
    await useMeetingsStore.getState().update("m-1", "org-1", { paused: true });
    expect(patch.mock.calls[0]?.[1]).toEqual({ paused: true });
  });

  // `false` es un valor, no una ausencia: si se colara por un `if (patch.paused)`
  // en algún sitio, despausar no haría nada y nadie sabría por qué.
  it("y despausar también", async () => {
    await useMeetingsStore.getState().update("m-1", "org-1", { paused: false });
    expect(patch.mock.calls[0]?.[1]).toEqual({ paused: false });
  });
});

describe("a quién le llega", () => {
  it("viaja como la lista de excluidos", async () => {
    await useMeetingsStore.getState().setExcluded("m-1", "org-1", ["u-bea"]);
    const [url, cuerpo] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("/api/v1/meetings/m-1/recipients");
    expect(cuerpo).toEqual({ excludedUserIds: ["u-bea"] });
  });

  // Quitar a todo el mundo de la lista de excluidos es «que le llegue a todos»,
  // y tiene que mandarse: omitirlo dejaría las exclusiones viejas puestas.
  it("vaciarla se manda, no se omite", async () => {
    await useMeetingsStore.getState().setExcluded("m-1", "org-1", []);
    expect(put.mock.calls[0]?.[1]).toEqual({ excludedUserIds: [] });
  });
});
