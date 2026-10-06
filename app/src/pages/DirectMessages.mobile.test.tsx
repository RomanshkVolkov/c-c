import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Directos en un teléfono: la lista o la conversación, no las dos (captura de
 * jose, 5-oct-2026: el hilo, al lado de la lista, se leía palabra a palabra).
 * El hilo ya trae su flecha de volver (`onBack` → `close`). Mutantes: no
 * esconder la lista con un directo abierto; esconderla también en escritorio.
 */

const estado = { conversationId: null as string | null };
vi.mock("@/store/dm.store", () => {
  const s = () => ({
    conversationId: estado.conversationId,
    conversationOrgId: "org-1",
    open: vi.fn(),
    openWith: vi.fn(),
    close: vi.fn(),
  });
  return {
    useDMStore: Object.assign(
      (sel?: (x: Record<string, unknown>) => unknown) => (sel ? sel(s()) : s()),
      { setState: vi.fn(), getState: () => ({ conversations: [], fetchConversations: async () => {} }) },
    ),
  };
});
vi.mock("@/store/orgs.store", () => {
  const s = { currentOrgId: "org-1", orgs: [{ id: "org-1" }], setCurrentOrg: vi.fn() };
  return { useOrgsStore: Object.assign((sel: (x: Record<string, unknown>) => unknown) => sel(s), { getState: () => s }) };
});
vi.mock("@/components/DMSwitcher", () => ({ default: () => <div>la lista</div> }));
vi.mock("@/components/DMThread", () => ({ default: () => <div>el hilo</div> }));

const { default: DirectMessages } = await import("./DirectMessages");

const montar = () =>
  render(
    <MemoryRouter initialEntries={["/dm"]}>
      <DirectMessages />
    </MemoryRouter>,
  );
const listaVisible = () => !screen.getByText("la lista").closest("aside")!.classList.contains("hidden");

let ancho = 390;
beforeEach(() => {
  ancho = 390;
  estado.conversationId = null;
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => ancho });
});
afterEach(cleanup);

describe("directos en un teléfono", () => {
  it("sin conversación abierta, la lista a todo el ancho", () => {
    montar();
    expect(listaVisible()).toBe(true);
    expect(screen.queryByText("el hilo")).toBeNull();
  });

  it("con una abierta, sólo la conversación", () => {
    estado.conversationId = "conv-1";
    montar();
    expect(screen.getByText("el hilo")).toBeTruthy();
    expect(listaVisible()).toBe(false);
  });

  it("en el escritorio, las dos", () => {
    ancho = 1280;
    estado.conversationId = "conv-1";
    montar();
    expect(screen.getByText("el hilo")).toBeTruthy();
    expect(listaVisible()).toBe(true);
  });
});
