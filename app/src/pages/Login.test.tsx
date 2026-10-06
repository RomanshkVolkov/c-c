import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

/**
 * El login no se queda en el camino (jose, en la web, 6-oct-2026): con la
 * sesión abierta, «atrás» lo enseñaba como si no hubiera entrado, y atrás y
 * adelante daban vueltas. Mutantes: no redirigir con sesión; entrar sin
 * `replace` (el login sigue detrás en el historial).
 */
const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ login }) }));

const { default: Login } = await import("./Login");
const { useAuthStore } = await import("@/store/auth.store");

function Dentro() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>atrás</button>;
}
const montar = (entradas: string[]) =>
  render(
    <MemoryRouter initialEntries={entradas} initialIndex={entradas.length - 1}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/overview" element={<Dentro />} />
        <Route path="/inicio" element={<p>inicio</p>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  login.mockReset().mockImplementation(async () => useAuthStore.setState({ accessToken: "a" } as never));
  useAuthStore.setState({ accessToken: null, session: null } as never);
});
afterEach(cleanup);

describe("el login", () => {
  it("con la sesión abierta lleva dentro", () => {
    useAuthStore.setState({ accessToken: "a" } as never);
    montar(["/login"]);
    expect(screen.getByRole("button", { name: "atrás" })).toBeTruthy();
  });

  it("al entrar no se queda en el historial", async () => {
    montar(["/inicio", "/login"]);
    const [usuario, clave] = Array.from(document.querySelectorAll("input"));
    fireEvent.change(usuario, { target: { value: "ana" } });
    fireEvent.change(clave, { target: { value: "una-clave-larga" } });
    fireEvent.submit(usuario.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "atrás" }));
    await waitFor(() => expect(screen.getByText("inicio")).toBeTruthy());
  });
});
