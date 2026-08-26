import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Aceptar una invitación tiene que **renovar la sesión**.
 *
 * El token lleva dentro a qué organizaciones perteneces, y todo lo que autoriza
 * se resuelve contra eso y no contra la base. Sin renovarlo, la membresía queda
 * creada en el servidor y la credencial en la mano sigue diciendo que no
 * perteneces a nada: la app se ve vacía hasta cerrar sesión y volver a entrar.
 *
 * Le pasa a **cada persona nueva** que entra, y en su primer minuto.
 */

const { post, refresh } = vi.hoisted(() => ({ post: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { post, get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  refreshAccessToken: refresh,
}));

const { useInvitationsStore } = await import("@/store/invitations.store");

beforeEach(() => {
  post.mockClear();
  refresh.mockClear();
  post.mockResolvedValue({ success: true });
  refresh.mockResolvedValue("un-token-nuevo");
  useInvitationsStore.setState({ pending: [{ id: "inv-1" }] as never });
});

describe("aceptar una invitación", () => {
  it("renueva el token, no sólo llama al endpoint", async () => {
    await useInvitationsStore.getState().accept("inv-1");
    expect(refresh).toHaveBeenCalled();
  });

  // El orden importa: renovar antes de que quien llame se ponga a leer datos de
  // la organización nueva, o leería con la credencial vieja.
  it("y lo renueva después de aceptar, no antes", async () => {
    const orden: string[] = [];
    post.mockImplementation(async () => {
      orden.push("aceptar");
      return { success: true };
    });
    refresh.mockImplementation(async () => {
      orden.push("renovar");
      return "t";
    });
    await useInvitationsStore.getState().accept("inv-1");
    expect(orden).toEqual(["aceptar", "renovar"]);
  });

  it("dice que la sesión quedó al día", async () => {
    const r = await useInvitationsStore.getState().accept("inv-1");
    expect(r.renovado).toBe(true);
  });

  // Lo importante del caso feo: la invitación **sí** se aceptó. Decir «no se
  // pudo» llevaría a reintentar sobre una invitación ya gastada.
  it("y avisa cuando no pudo renovar, sin fingir que falló todo", async () => {
    refresh.mockResolvedValue(null);
    const r = await useInvitationsStore.getState().accept("inv-1");
    expect(r.renovado).toBe(false);
    expect(useInvitationsStore.getState().pending).toHaveLength(0);
  });

  // Si el endpoint falla no hay nada que renovar: gastar una renovación ahí
  // sería pedirle trabajo al servidor por una operación que no ocurrió.
  it("si aceptar falla, no renueva nada", async () => {
    post.mockResolvedValue({ success: false, error: "gone" });
    await expect(useInvitationsStore.getState().accept("inv-1")).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });
});
