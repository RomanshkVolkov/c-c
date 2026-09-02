import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Editar tus propios datos.
 *
 * La pantalla es sencilla; lo que merece prueba son las dos reglas que no se
 * ven mirándola:
 *
 * 1. **Se relee la sesión al guardar.** El nombre se pinta desde ahí en el menú
 *    de la cuenta y en media aplicación, así que sin esto se guarda bien y se
 *    sigue viendo el de antes hasta reiniciar — que parece que no se guardó.
 * 2. **El usuario no se manda.** Es el identificador y cambiarlo rompería las
 *    menciones ya escritas en hilos y tarjetas.
 */

const patch = vi.fn<(p: string, b: unknown) => Promise<unknown>>(async () => ({ success: true }));
const refreshSession = vi.fn(async () => {});
vi.mock("@/lib/api", () => ({
  api: { patch: (p: string, b: unknown) => patch(p, b) },
  refreshSession: () => refreshSession(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ session: { id: "u", username: "rvolkov", name: "Romanshk", email: "r@x.com" } }),
}));

const { default: Profile } = await import("@/pages/Profile");

describe("el perfil", () => {
  beforeEach(() => {
    cleanup();
    patch.mockClear();
    refreshSession.mockClear();
  });

  it("llega con lo que ya tienes puesto", () => {
    render(<Profile />);
    expect((screen.getByLabelText(/nombre|name/i) as HTMLInputElement).value).toBe("Romanshk");
  });

  it("guarda el nombre y **relee la sesión**", async () => {
    render(<Profile />);
    fireEvent.change(screen.getByLabelText(/nombre|name/i), { target: { value: "Romanshk Volkov" } });
    fireEvent.click(screen.getByRole("button", { name: /guardar|save/i }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]![1]).toMatchObject({ name: "Romanshk Volkov" });
    await waitFor(() => expect(refreshSession).toHaveBeenCalled());
  });

  // El usuario se enseña, no se edita.
  it("no manda el usuario", async () => {
    render(<Profile />);
    fireEvent.click(screen.getByRole("button", { name: /guardar|save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]![1]).not.toHaveProperty("username");
  });
});
