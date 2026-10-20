import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Dar de alta por correo, del lado del admin. Lo que se fija:
 *
 * 1. Manda nombre, correo y rol, y sin ellos no se puede.
 * 2. Si el correo salió, sólo se dice; el enlace **no** se enseña (quien lo
 *    tiene elige la contraseña de otra persona).
 * 3. Si no salió, el enlace se enseña para pasarlo a mano.
 * 4. Si ya tenía cuenta, se dice que se le invitó.
 */
const { createAccount, toast } = vi.hoisted(() => ({
  createAccount: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ createAccount }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

const { default: OrgCreateAccount } = await import("./OrgCreateAccount");

const onDone = vi.fn();
const montar = () => render(<OrgCreateAccount orgId="org-1" orgName="Dwit" defaultRole="member" onDone={onDone} />);
const llenar = (name: string, email: string) => {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
};
const boton = () => screen.getByRole("button", { name: /^Add$/ }) as HTMLButtonElement;

beforeEach(() => {
  createAccount.mockReset();
  onDone.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe("dar de alta por correo", () => {
  it("con el correo enviado sólo se dice, sin enseñar el enlace", async () => {
    createAccount.mockResolvedValue({ status: "created", userId: "u", emailSent: true });
    montar();
    llenar("Caro", "no-es-correo");
    expect(boton().disabled).toBe(true);
    llenar(" Caro ", " caro@x.io ");
    fireEvent.click(boton());
    await waitFor(() => expect(createAccount).toHaveBeenCalledWith("org-1", { name: "Caro", email: "caro@x.io", role: "member" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("We sent the link to caro@x.io."));
    expect(screen.queryByTestId("account-link")).toBeNull();
    expect(onDone).toHaveBeenCalled();
  });

  it("si el correo no salió, enseña el enlace para pasarlo a mano", async () => {
    createAccount.mockResolvedValue({ status: "created", userId: "u", emailSent: false, link: "https://cac.test/app/welcome#t" });
    montar();
    llenar("Caro", "caro@x.io");
    fireEvent.click(boton());
    expect((await screen.findByTestId("account-link")).textContent).toBe("https://cac.test/app/welcome#t");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("si ya tenía cuenta, dice que se le invitó", async () => {
    createAccount.mockResolvedValue({ status: "invited", userId: "u", emailSent: true });
    montar();
    llenar("Bea", "bea@x.io");
    fireEvent.click(boton());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("bea@x.io already had an account: we invited them to Dwit."));
  });

  it("un error del servidor se lee en tu idioma", async () => {
    createAccount.mockRejectedValue(Object.assign(new Error("already-member"), { code: "already-member" }));
    montar();
    llenar("Bea", "bea@x.io");
    fireEvent.click(boton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already a member of this organization."));
  });
});
