import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Crear una organización también renueva la sesión.
 *
 * Es el mismo agujero que al aceptar una invitación: la pertenencia viaja
 * dentro del token, así que crear una y entrar en ella sin renovar la abriría
 * **vacía**. Y aquí es peor de entender — quien la acaba de crear no puede
 * achacarlo a «todavía no me han dado permisos».
 */

const { post, refresh } = vi.hoisted(() => ({ post: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { post, get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  refreshAccessToken: refresh,
}));

const { useOrgsStore } = await import("@/store/orgs.store");

const ORG = { id: "org-9", name: "Nueva", slug: "nueva" };

beforeEach(() => {
  post.mockClear();
  refresh.mockClear();
  post.mockResolvedValue({ success: true, data: ORG });
  refresh.mockResolvedValue("un-token-nuevo");
  useOrgsStore.setState({ orgs: [], currentOrgId: null });
});

describe("crear una organización", () => {
  it("renueva el token antes de meterte dentro", async () => {
    const orden: string[] = [];
    post.mockImplementation(async () => {
      orden.push("crear");
      return { success: true, data: ORG };
    });
    refresh.mockImplementation(async () => {
      orden.push("renovar");
      return "t";
    });
    await useOrgsStore.getState().createOrg({ name: "Nueva" } as never);
    expect(orden).toEqual(["crear", "renovar"]);
  });

  it("y te deja dentro de ella", async () => {
    await useOrgsStore.getState().createOrg({ name: "Nueva" } as never);
    expect(useOrgsStore.getState().currentOrgId).toBe("org-9");
  });

  it("si crear falla no renueva nada", async () => {
    post.mockResolvedValue({ success: false, error: "nope" });
    await expect(useOrgsStore.getState().createOrg({ name: "x" } as never)).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });
});
