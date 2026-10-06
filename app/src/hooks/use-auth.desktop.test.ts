import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * El escritorio no pide sesión web: si la pidiera, el servidor le cerraría los
 * servidores y los tokens personales. Mutante: mandar `client: "web"` siempre.
 */
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post }, revokeSession: vi.fn() }));
vi.mock("@/lib/locale-sync", () => ({ adoptServerLocale: vi.fn() }));

const { useAuth } = await import("./use-auth");

describe("la sesión en el escritorio", () => {
  it("el login no pide sesión web", async () => {
    post.mockResolvedValue({ success: true, data: { session: { id: "u-1" }, accessToken: "a", refreshToken: "r" } });
    const { result } = renderHook(() => useAuth());
    await result.current.login("ana", "clave");
    expect(post).toHaveBeenCalledWith("/api/v1/auth/login", { username: "ana", password: "clave" });
  });
});
