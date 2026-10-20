import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/**
 * A donde lleva el enlace del correo (alta por correo, restablecer la
 * contraseña). Lo que se fija:
 *
 * 1. Saluda a la persona con lo que dice el enlace, sin gastarlo.
 * 2. No se puede guardar hasta que el usuario y la contraseña valen.
 * 3. El usuario va en minúsculas, como lo guarda el servidor.
 * 4. Un usuario ocupado se dice y se deja elegir otro; un enlace que no vale
 *    lleva a la pantalla de «ya no vale».
 * 5. Un enlace de restablecer abierto como bienvenida no vale aquí.
 * 6. Al guardar se abre la sesión y se entra.
 */
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { post, get: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
  codigoDe: (e: unknown) => (e as { code?: string })?.code ?? "",
}));

const { default: AccountLink } = await import("./AccountLink");
const { useAuthStore } = await import("@/store/auth.store");

const info = (purpose: "welcome" | "reset") => ({
  success: true,
  data: { purpose, name: "Caro García", email: "caro@x.io", orgName: "Dwit" },
});
const session = {
  success: true,
  data: { accessToken: "a", refreshToken: "r", expiresIn: 1, session: { id: "u", username: "caro", name: "Caro", email: "caro@x.io", superadmin: false, mustChangePassword: false } },
};
const apiError = (code: string) => Object.assign(new Error(code), { code });

const montar = (mode: "welcome" | "reset") =>
  render(
    <MemoryRouter initialEntries={["/x", `/${mode}`]} initialIndex={1}>
      <Routes>
        <Route path={`/${mode}`} element={<AccountLink mode={mode} />} />
        <Route path="/overview" element={<p>dentro</p>} />
        <Route path="/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );

const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const guardar = () => screen.getByRole("button", { name: /Create my account|Save and sign in/ }) as HTMLButtonElement;

beforeEach(() => {
  post.mockReset();
  window.location.hash = "#tok-1";
  useAuthStore.setState({ accessToken: null, session: null } as never);
});
afterEach(cleanup);

describe("el enlace de bienvenida", () => {
  it("saluda con el enlace, pide usuario y contraseña válidos, y entra", async () => {
    post.mockImplementation(async (path: string) => (path.endsWith("/inspect") ? info("welcome") : session));
    montar("welcome");
    expect(await screen.findByText("Hi, Caro García")).toBeTruthy();
    expect(screen.getByText(/caro@x\.io in Dwit/)).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/public/account/inspect", { token: "tok-1" }, false);

    fill(/^Username$/, "c a");
    fill(/^Password$/, "una-buena-8");
    fill(/Repeat the password/, "una-buena-8");
    expect(guardar().disabled).toBe(true);
    fill(/^Username$/, " Caro.G ");
    fill(/Repeat the password/, "otra-cosa-8");
    expect(guardar().disabled).toBe(true);
    expect(screen.getByText("The passwords don't match")).toBeTruthy();
    fill(/Repeat the password/, "una-buena-8");
    expect(guardar().disabled).toBe(false);

    fireEvent.click(guardar());
    expect(await screen.findByText("dentro")).toBeTruthy();
    expect(post).toHaveBeenCalledWith(
      "/api/v1/public/account/welcome",
      { token: "tok-1", username: "caro.g", password: "una-buena-8" },
      false,
    );
    expect(useAuthStore.getState().accessToken).toBe("a");
  });

  it("un usuario ocupado se dice y deja elegir otro; un enlace gastado lleva a «ya no vale»", async () => {
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/inspect")) return info("welcome");
      throw apiError("username-taken");
    });
    montar("welcome");
    await screen.findByText("Hi, Caro García");
    fill(/^Username$/, "ana");
    fill(/^Password$/, "una-buena-8");
    fill(/Repeat the password/, "una-buena-8");
    fireEvent.click(guardar());
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/taken/);
    expect(screen.getByLabelText(/^Username$/)).toBeTruthy();

    post.mockImplementation(async () => {
      throw apiError("link-invalid");
    });
    fireEvent.click(guardar());
    expect(await screen.findByText("This link no longer works")).toBeTruthy();
  });

  it("un enlace que no vale, o que es de restablecer, no deja seguir", async () => {
    post.mockRejectedValue(apiError("link-invalid"));
    montar("welcome");
    expect(await screen.findByText("This link no longer works")).toBeTruthy();
    cleanup();

    post.mockReset().mockResolvedValue(info("reset"));
    montar("welcome");
    expect(await screen.findByText("This link no longer works")).toBeTruthy();
    expect(screen.queryByLabelText(/^Username$/)).toBeNull();
  });
});

describe("el enlace de restablecer", () => {
  it("pide sólo la contraseña nueva, y entra", async () => {
    post.mockImplementation(async (path: string) => (path.endsWith("/inspect") ? info("reset") : session));
    montar("reset");
    expect(await screen.findByText("Choose a new password")).toBeTruthy();
    expect(screen.queryByLabelText(/^Username$/)).toBeNull();
    fill(/^Password$/, "nueva-de-caro");
    fill(/Repeat the password/, "nueva-de-caro");
    fireEvent.click(guardar());
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/public/account/reset", { token: "tok-1", password: "nueva-de-caro" }, false),
    );
    expect(await screen.findByText("dentro")).toBeTruthy();
  });
});
