import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(async () => ({ success: true })), delete: vi.fn() } }));

import { useCalls, type CallKnock } from "./calls.store";

const knock = (status: CallKnock["status"], id = "g1", name = "Ana"): CallKnock => ({
  inviteId: "inv-1", title: "Con el cliente", createdBy: "u-host", status,
  guest: { id, name, createdAt: "2026-10-08T00:00:00Z" },
});

beforeEach(() => useCalls.setState({ waiting: {} }));

// La lista de quién espera la mantiene el stream: llega alguien, y se va cuando
// **cualquier** miembro decide — no sólo el que mira.
describe("la sala de espera en la pantalla", () => {
  it("quien llega aparece una vez, aunque el aviso se repita", () => {
    useCalls.getState().onKnock(knock("waiting"));
    useCalls.getState().onKnock(knock("waiting"));
    expect(useCalls.getState().waiting["inv-1"]).toHaveLength(1);
  });

  // El mutante que mata: añadir cualquier aviso. Entonces la decisión de otro
  // miembro volvería a poner a la persona en la lista.
  it("cuando otro decide, se va de la lista", () => {
    useCalls.getState().onKnock(knock("waiting"));
    useCalls.getState().onKnock(knock("waiting", "g2", "Bea"));
    useCalls.getState().onKnock(knock("admitted"));
    expect(useCalls.getState().waiting["inv-1"].map((g) => g.name)).toEqual(["Bea"]);
    useCalls.getState().onKnock(knock("rejected", "g2"));
    expect(useCalls.getState().waiting["inv-1"]).toEqual([]);
  });
});
