import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Crear un usuario.
 *
 * jose llenó el diálogo y «Crear» no se encendía, sin decir por qué: el botón
 * pedía usuario ≥ 3 y contraseña ≥ 8, y lo único que lo contaba era un
 * placeholder que desaparece al escribir. Lo que se fija aquí:
 *
 * 1. Con todo bien puesto, el botón se enciende y manda nombre y correo.
 * 2. Apagado nunca en silencio: cada campo que falla dice qué le falta.
 * 3. Nombre y correo son obligatorios (decisión del 28-sep-2026, la misma
 *    regla que `CreateUserRequest` en el backend).
 */

const createUser = vi.fn(async (p: unknown) => ({ id: "n", ...(p as object) }));
const state = {
  users: [],
  loading: false,
  error: null,
  fetchUsers: vi.fn(),
  deleteUser: vi.fn(),
  updateUser: vi.fn(),
  createUser: (p: unknown) => createUser(p),
};
vi.mock("@/store/users.store", () => ({
  useUsersStore: (sel: (s: unknown) => unknown) => sel(state),
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ session: { id: "me" } }),
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: Users } = await import("@/pages/Users");

const field = (re: RegExp) => screen.getByLabelText(re) as HTMLInputElement;
const type = (re: RegExp, value: string) => fireEvent.change(field(re), { target: { value } });
const createButton = () => screen.getByRole("button", { name: /^(crear|create)$/i }) as HTMLButtonElement;

function openDialog() {
  render(<Users />);
  fireEvent.click(screen.getByRole("button", { name: /(usuario nuevo|new user)/i }));
}

function fillAll() {
  type(/^(usuario|username)$/i, "ana");
  type(/^(contraseña|password)$/i, "12345678");
  type(/^(nombre|name)$/i, "Ana López");
  type(/^(correo|email)$/i, "ana@x.com");
}

describe("crear un usuario", () => {
  beforeEach(() => {
    cleanup();
    createUser.mockClear();
  });

  it("con todo puesto, el botón se enciende y manda nombre y correo", async () => {
    openDialog();
    expect(createButton().disabled).toBe(true);
    fillAll();
    expect(createButton().disabled).toBe(false);

    fireEvent.click(createButton());
    await waitFor(() => expect(createUser).toHaveBeenCalled());
    expect(createUser.mock.calls[0][0]).toMatchObject({
      username: "ana",
      password: "12345678",
      name: "Ana López",
      email: "ana@x.com",
    });
  });

  it("sin correo no se crea, y lo dice", () => {
    openDialog();
    fillAll();
    type(/^(correo|email)$/i, "");
    fireEvent.blur(field(/^(correo|email)$/i));
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/(falta el correo|email is required)/i)).toBeTruthy();
  });

  it("un correo que no lo es, tampoco", () => {
    openDialog();
    fillAll();
    type(/^(correo|email)$/i, "ana@");
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/(no parece un correo|doesn't look like an email)/i)).toBeTruthy();
  });

  it("sin nombre —o con sólo espacios— no se crea, y lo dice", () => {
    openDialog();
    fillAll();
    type(/^(nombre|name)$/i, "   ");
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/(falta el nombre|name is required)/i)).toBeTruthy();
  });

  it("una contraseña de 7 dice cuántos caracteres lleva", () => {
    openDialog();
    fillAll();
    type(/^(contraseña|password)$/i, "1234567");
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/\(\s*(van\s*)?7(\s*so far)?\s*\)/i)).toBeTruthy();
  });

  it("el botón apagado dice en su título todo lo que falta", () => {
    openDialog();
    type(/^(usuario|username)$/i, "ana");
    const title = createButton().title;
    expect(title).toMatch(/(contraseña|password)/i);
    expect(title).toMatch(/(nombre|name)/i);
    expect(title).toMatch(/(correo|email)/i);
    expect(title).not.toMatch(/(usuario lleva|username needs)/i);
  });
});
