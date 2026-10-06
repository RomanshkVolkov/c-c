import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * «Añadir directamente» a alguien que no es de tu gente: el servidor pide
 * invitarlo (cualquiera puede crearse una org, así que meter sin aceptar sólo
 * vale para quien ya administras), y la pantalla lo invita en vez de dejar un
 * error. Mutante: no caer a la invitación.
 */
const { addMember, createInvitation, info } = vi.hoisted(() => ({
  addMember: vi.fn(),
  createInvitation: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      createInvitation,
      revokeInvitation: vi.fn(),
      resendInvitation: vi.fn(),
      listOrgInvitations: vi.fn().mockResolvedValue([]),
      addMember,
    }),
}));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/UserPicker", () => ({
  default: ({ onSelect }: { onSelect: (u: { id: string; username: string }) => void }) => (
    <button onClick={() => onSelect({ id: "u-dan", username: "dan" })}>elegir</button>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info } }));

const { default: OrgInvitations } = await import("@/components/org/OrgInvitations");

afterEach(cleanup);

describe("añadir a alguien que no es de tu gente", () => {
  it("se le invita", async () => {
    addMember.mockRejectedValue(new Error("invite-required"));
    createInvitation.mockResolvedValue(undefined);
    render(
      <OrgInvitations orgId="o" orgName="Uno" invites={[]} setInvites={() => {}} canManage defaultRole="member" onAdded={() => {}} />,
    );
    fireEvent.click(screen.getByText("elegir"));
    fireEvent.click(screen.getByRole("button", { name: /(add directly|añadir directamente)/i }));
    await waitFor(() => expect(createInvitation).toHaveBeenCalledWith("o", { userId: "u-dan", role: "member" }));
    expect(info).toHaveBeenCalled();
  });
});
