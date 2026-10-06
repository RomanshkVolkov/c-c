import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Cambiar la contraseña cierra todas las sesiones en el servidor, también ésta:
 * el refresh guardado queda revocado. La pantalla guarda la sesión nueva que
 * devuelve el servidor en vez de renovar con la vieja (sería un 401 y sacaría a
 * quien la acaba de cambiar). Mutantes: no guardar los tokens; renovar igual.
 */
const { post, refreshAccessToken, refreshSession } = vi.hoisted(() => ({
  post: vi.fn(),
  refreshAccessToken: vi.fn(async () => {}),
  refreshSession: vi.fn(async () => {}),
}));
vi.mock("@/lib/api", () => ({ api: { post }, refreshAccessToken, refreshSession }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const { ChangePasswordForm } = await import("./ChangePassword");
const { useAuthStore } = await import("@/store/auth.store");
const { useOrgsStore } = await import("@/store/orgs.store");

beforeEach(() => {
  post.mockReset();
  refreshAccessToken.mockClear();
  useAuthStore.setState({ session: { id: "u-1", username: "ana" }, accessToken: "a-viejo", refreshToken: "r-viejo" } as never);
  useOrgsStore.setState({ fetchOrgs: vi.fn(async () => {}) } as never);
});
afterEach(cleanup);

function cambiar() {
  const [actual, nueva, otra] = Array.from(document.querySelectorAll("input"));
  fireEvent.change(actual, { target: { value: "vieja-clave" } });
  fireEvent.change(nueva, { target: { value: "nueva-clave-larga" } });
  fireEvent.change(otra, { target: { value: "nueva-clave-larga" } });
  const botones = screen.getAllByRole("button");
  fireEvent.click(botones[botones.length - 1]);
}

describe("cambiar la contraseña", () => {
  it("se queda con la sesión nueva y no renueva con la revocada", async () => {
    post.mockResolvedValue({ success: true, data: { accessToken: "a-nuevo", refreshToken: "r-nuevo" } });
    const onDone = vi.fn();
    render(<ChangePasswordForm onDone={onDone} />);
    cambiar();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(useAuthStore.getState().refreshToken).toBe("r-nuevo");
    expect(useAuthStore.getState().accessToken).toBe("a-nuevo");
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(refreshSession).toHaveBeenCalled();
  });

  it("con un servidor de antes, renueva como siempre", async () => {
    post.mockResolvedValue({ success: true });
    const onDone = vi.fn();
    render(<ChangePasswordForm onDone={onDone} />);
    cambiar();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(refreshAccessToken).toHaveBeenCalled();
  });
});
