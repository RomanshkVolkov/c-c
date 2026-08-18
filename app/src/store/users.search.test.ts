import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La búsqueda manda —o no— la organización, y ahí se decide todo.
 *
 * El selector puede elegir bien el alcance y dar igual, si el store no traduce
 * esa elección a la URL. Se comprueba aquí porque el test del selector mockea
 * el store, así que este tramo no lo mira nadie más.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post: vi.fn(), delete: vi.fn(), patch: vi.fn() } }));

const { useUsersStore } = await import("@/store/users.store");

beforeEach(() => {
  get.mockClear();
  get.mockResolvedValue({ success: true, data: [] });
});

const url = () => String(get.mock.calls[get.mock.calls.length - 1][0]);

describe("buscar personas", () => {
  it("acotada a una organización, lo dice en la petición", async () => {
    await useUsersStore.getState().search("jo", "org-1");
    expect(url()).toContain("orgId=org-1");
  });

  it("sin acotar, no se lo inventa", async () => {
    await useUsersStore.getState().search("jo");
    expect(url()).not.toContain("orgId");
  });
});
