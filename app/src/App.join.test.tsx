import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * La puerta del invitado se abre **sin sesión**. Quien llega con el enlace no
 * tiene cuenta, y si la ruta quedara dentro de `ProtectedRoute` le mandaría al
 * login — una pantalla en la que no puede hacer nada. El mutante que mata:
 * mover `/join` dentro del grupo protegido.
 */
vi.stubEnv("VITE_TARGET", "web");
vi.mock("@/lib/platform", () => ({ isTauri: false, isWeb: true, isWebBuild: true, openExternal: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@/pages/JoinCall", () => ({ default: () => <p>la puerta del invitado</p> }));

const { default: App } = await import("@/App");
const { useAuthStore } = await import("@/store/auth.store");

afterEach(cleanup);

describe("la ruta /join", () => {
  it("se pinta sin haber iniciado sesión", async () => {
    useAuthStore.setState({ accessToken: null, refreshToken: null, user: null } as never);
    window.history.pushState({}, "", "/join#inv-1.firma");
    render(<App />);
    expect(await screen.findByText("la puerta del invitado")).toBeTruthy();
    expect(window.location.pathname).toBe("/join");
  });
});
