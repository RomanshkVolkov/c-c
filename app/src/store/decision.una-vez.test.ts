import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Publicar y registrar son un solo gesto.
 *
 * Si fueran dos peticiones, la segunda puede fallar: quedaría un comentario que
 * dice haber decidido algo y ningún registro de qué. Y el reintento tendría que
 * saber que la primera ya salió, o dejaría dos comentarios. Va todo junto, y el
 * **origen lo pone quien llama** — no el formulario, porque una decisión que
 * dice venir de otra tarea es un enlace de vuelta que miente.
 */

const post = vi.fn(async (_p: string, _b: unknown) => ({ success: true, data: null }));

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async () => ({ success: true, data: {} })),
    post: (p: string, b: unknown) => post(p, b),
    put: vi.fn(async () => ({ success: true, data: {} })),
    patch: vi.fn(async () => ({ success: true, data: {} })),
    delete: vi.fn(async () => ({ success: true, data: {} })),
  },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ session: { id: "yo" } }), subscribe: vi.fn() },
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: { getState: () => ({ currentOrgId: "o1" }), subscribe: vi.fn() },
}));
vi.mock("@/store/mywork.store", () => ({
  useMyWorkStore: { getState: () => ({ refresh: vi.fn(), olvidar: vi.fn() }), subscribe: vi.fn() },
}));

const { useTasksStore } = await import("@/store/tasks.store");

beforeEach(() => post.mockClear());

describe("/decision en una tarjeta", () => {
  it("el comentario y la entrada salen en la misma petición", async () => {
    await useTasksStore
      .getState()
      .addComment("t1", "lo hablamos y va así", undefined, {
        title: "Postgres, no Mongo",
        body: "las consultas son relacionales",
        tag: "arquitectura",
      });

    const deComentario = post.mock.calls.filter(([p]) => p.includes("/comments"));
    expect(deComentario).toHaveLength(1);
    // Y ninguna segunda llamada al registro: si la hubiera, podría fallar sola.
    expect(post.mock.calls.filter(([p]) => p.includes("/decisions"))).toHaveLength(0);
  });

  // El origen no lo escribe el formulario. Aceptarlo del cliente dejaría que una
  // entrada dijera venir de una tarea que no es la suya.
  it("el origen va marcado como la tarea, sin que nadie lo escriba", async () => {
    await useTasksStore
      .getState()
      .addComment("t1", "va así", undefined, { title: "Eso", body: "", tag: "" });

    const [, cuerpo] = post.mock.calls.find(([p]) => p.includes("/comments"))!;
    expect(cuerpo).toMatchObject({ decision: { origin: "task", title: "Eso" } });
  });

  it("un comentario normal no lleva decisión encima", async () => {
    await useTasksStore.getState().addComment("t1", "sólo un comentario");
    const [, cuerpo] = post.mock.calls.find(([p]) => p.includes("/comments"))!;
    expect(cuerpo).not.toHaveProperty("decision");
  });
});
