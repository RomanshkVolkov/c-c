import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * «¿Olvidaste tu contraseña?» en el login: un campo, prerrellenado con el
 * usuario si ya se escribió, y la misma respuesta exista o no la cuenta.
 * Mutantes: no prerrellenar; decir algo distinto según exista; tragarse el
 * error de «sin correo configurado».
 */
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { post, get: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
  codigoDe: (e: unknown) => (e as { code?: string })?.code ?? "",
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ login: vi.fn() }) }));

const { default: Login } = await import("./Login");
const { useAuthStore } = await import("@/store/auth.store");

const montar = () =>
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <Login />
    </MemoryRouter>,
  );

beforeEach(() => {
  post.mockReset();
  useAuthStore.setState({ accessToken: null, session: null } as never);
});
afterEach(cleanup);

describe("olvidé mi contraseña", () => {
  it("pide el enlace con lo ya escrito y contesta igual exista o no", async () => {
    post.mockResolvedValue({ success: true });
    montar();
    fireEvent.change(document.querySelector("#username")!, { target: { value: "ana" } });
    fireEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    const campo = screen.getByLabelText("Username or email") as HTMLInputElement;
    expect(campo.value).toBe("ana");
    fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
    expect(await screen.findByText(/If there is an account with that username or email/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/public/account/forgot", { login: "ana" }, false);

    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(document.querySelector("#password")).toBeTruthy();
  });

  it("sin correo en el servidor, lo dice", async () => {
    post.mockRejectedValue(Object.assign(new Error("email-off"), { code: "email-off" }));
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
    fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "ana@x.io" } });
    fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/doesn't have email set up/);
  });
});
