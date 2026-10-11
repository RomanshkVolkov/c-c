import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * «Más», en el teléfono. Como en el móvil ya no hay hamburguesa, lo que no
 * esté aquí no se alcanza: el resto de pantallas, los espacios (la única forma
 * de entrar a un tablero), la organización y la cuenta. Mutantes: repetir los
 * tres botones del menú; quitar los espacios; quitar la cuenta; enseñar
 * Usuarios a quien no es superadmin.
 */
const { auth } = vi.hoisted(() => ({ auth: { superadmin: false } }));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ session: { superadmin: auth.superadmin } }),
}));
vi.mock("@/store/invitations.store", () => ({
  useInvitationsStore: (sel: (s: unknown) => unknown) => sel({ pending: [] }),
}));
vi.mock("@/components/OrgSwitcher", () => ({ default: () => <div>la organización</div> }));
vi.mock("@/components/tree/SpacesNavigator", () => ({ default: () => <div>los espacios</div> }));
vi.mock("@/components/AccountMenu", () => ({ default: () => <div>la cuenta</div> }));
vi.mock("@/components/ChangePassword", () => ({ ChangePasswordDialog: () => null }));

const { default: MoreSheet } = await import("./MoreSheet");

const montar = () =>
  render(
    <MemoryRouter>
      <MoreSheet open onOpenChange={() => {}} />
    </MemoryRouter>,
  );
const destinos = () =>
  Array.from(screen.getByRole("navigation", { name: "Go to" }).querySelectorAll("button"), (b) => b.textContent);

afterEach(cleanup);

describe("la hoja «Más»", () => {
  it("lleva el resto de pantallas, sin repetir las del menú", () => {
    montar();
    const d = destinos();
    expect(d).toEqual(expect.arrayContaining(["Overview", "All docs", "Notes", "Activity"]));
    for (const del_menu of ["My work", "Channels", "Direct messages"]) expect(d).not.toContain(del_menu);
  });

  it("Usuarios, sólo para superadmin", () => {
    montar();
    expect(destinos()).not.toContain("Users");
    cleanup();
    auth.superadmin = true;
    montar();
    expect(destinos()).toContain("Users");
    auth.superadmin = false;
  });

  it("y los espacios, la organización y la cuenta", () => {
    montar();
    expect(screen.getByText("los espacios")).toBeTruthy();
    expect(screen.getByText("la organización")).toBeTruthy();
    expect(screen.getByText("la cuenta")).toBeTruthy();
  });
});
