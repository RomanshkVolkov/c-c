import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Invitation } from "@/types/organization";

/**
 * Una invitación caducada tiene que verse, y poder revivirse.
 *
 * Antes la lista escondía las vencidas —igual que la del invitado, donde sí
 * corresponde— y el resultado era un callejón: no se podía retirar la que no
 * aparecía, y crear otra chocaba con la guarda de «ya hay una pendiente».
 */

const resend = vi.fn().mockResolvedValue(undefined);
const list = vi.fn().mockResolvedValue([]);

vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      createInvitation: vi.fn(),
      revokeInvitation: vi.fn(),
      resendInvitation: resend,
      listOrgInvitations: list,
      addMember: vi.fn(),
    }),
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock("@/components/UserPicker", () => ({ default: () => <div /> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: OrgInvitations } = await import("@/components/org/OrgInvitations");

afterEach(() => {
  cleanup();
  resend.mockClear();
  list.mockClear();
});

const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();
const dentroDe = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString();

const INVITACIONES: Invitation[] = [
  {
    id: "viva", orgId: "o", orgName: "Uno", role: "member", status: "pending",
    invitedBy: "ana", invitedUser: "bea", createdAt: hace(1), expiresAt: dentroDe(13),
  },
  {
    id: "vencida", orgId: "o", orgName: "Uno", role: "viewer", status: "pending",
    invitedBy: "ana", invitedUser: "caro", createdAt: hace(20), expiresAt: hace(6),
  },
];

const montar = (invites = INVITACIONES, canManage = true) =>
  render(
    <OrgInvitations
      orgId="o" orgName="Uno" invites={invites} setInvites={() => {}}
      canManage={canManage} defaultRole="member" onAdded={() => {}}
    />,
  );

describe("invitaciones de la organización", () => {
  it("marca la caducada como tal y deja la vigente con su plazo", () => {
    montar();
    expect(screen.getByText("expired")).toBeTruthy();
    // La viva no puede decir lo mismo: si ambas dijeran «expired» el chip no
    // estaría distinguiendo nada.
    expect(screen.getAllByText("expired")).toHaveLength(1);
    // Sin fijar el número: el plazo pierde los milisegundos que van de crear la
    // invitación a leerla, y 13 días exactos se leen como 12.
    expect(screen.getByText(/^\d+ d left$/)).toBeTruthy();
  });

  it("dice quién invitó y cuándo", () => {
    montar();
    expect(screen.getByText(/invited by @ana · yesterday/)).toBeTruthy();
  });

  it("reenviar le pide al servidor y vuelve a leer la lista", async () => {
    montar();
    fireEvent.click(screen.getAllByRole("button", { name: /Resend/ })[1]);
    await waitFor(() => expect(resend).toHaveBeenCalledWith("o", "vencida"));
    // Sin releer, la fila seguiría diciendo «expired» después de revivirla.
    await waitFor(() => expect(list).toHaveBeenCalledWith("o"));
  });

  it("sin nada pendiente lo dice, en vez de no mostrar nada", () => {
    montar([]);
    expect(screen.getByText("No pending invitations.")).toBeTruthy();
  });

  it("quien no administra no ve los botones que no puede usar", () => {
    montar(INVITACIONES, false);
    expect(screen.queryByRole("button", { name: /Resend/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
  });
});
