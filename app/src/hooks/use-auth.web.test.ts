import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * Entrar y salir en la versión web (barrido, 6-oct-2026). El login pide una
 * sesión web, que el servidor marca en el token y a la que le cierra lo que es
 * sólo del escritorio; salir olvida el navegador (`leaveWeb`). Mutantes: no
 * mandar `client`; salir como el escritorio.
 */
vi.stubEnv("VITE_TARGET", "web");
const { post, revokeSession, leaveWeb } = vi.hoisted(() => ({
  post: vi.fn(),
  revokeSession: vi.fn(async () => {}),
  leaveWeb: vi.fn(async () => {}),
}));
vi.mock("@/lib/api", () => ({ api: { post }, revokeSession }));
vi.mock("@/lib/leave-web", () => ({ leaveWeb }));
vi.mock("@/lib/locale-sync", () => ({ adoptServerLocale: vi.fn() }));

const { useAuth } = await import("./use-auth");
const { useAuthStore } = await import("@/store/auth.store");

beforeEach(() => {
  post.mockReset().mockResolvedValue({
    success: true,
    data: { session: { id: "u-1", username: "ana" }, accessToken: "a", refreshToken: "r" },
  });
  leaveWeb.mockClear();
  revokeSession.mockClear();
});

describe("la sesión en la web", () => {
  it("el login pide una sesión web", async () => {
    const { result } = renderHook(() => useAuth());
    await result.current.login("ana", "clave");
    expect(post).toHaveBeenCalledWith("/api/v1/auth/login", { username: "ana", password: "clave", client: "web" });
  });

  it("salir olvida este navegador con el refresh que había", async () => {
    useAuthStore.setState({ refreshToken: "r-9" } as never);
    const { result } = renderHook(() => useAuth());
    result.current.logout();
    expect(leaveWeb).toHaveBeenCalledWith("r-9");
    expect(revokeSession).not.toHaveBeenCalled();
  });
});
