import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * El último directo recordado se abre solo **sólo en pantalla ancha**. En el
 * teléfono, entrar a Directos enseña la lista, como Canales: abrirlo solo te
 * dejaba dentro de un hilo que no pediste, sin el menú de abajo (que se esconde
 * en una conversación). Y tiene que valer **desde el primer render**: el
 * efecto que abre corre en el mismo ciclo en que `useIsMobile` decide, y con
 * el hook empezando en «no» se abría igual (11-oct-2026).
 * Mutantes: quitar la condición del móvil; `useIsMobile` empezando en falso.
 */
const { open } = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("@/components/mobile/CommsSwitch", () => ({ default: () => null }));
vi.mock("@/store/dm.store", () => {
  const s = () => ({
    conversationId: null,
    conversationOrgId: null,
    conversations: [],
    open,
    openWith: vi.fn(),
    close: vi.fn(),
    fetchConversations: async () => {},
  });
  return {
    useDMStore: Object.assign((sel?: (x: Record<string, unknown>) => unknown) => (sel ? sel(s()) : s()), {
      setState: vi.fn(),
      getState: s,
    }),
  };
});
vi.mock("@/store/orgs.store", () => {
  const s = { currentOrgId: "org-1", orgs: [{ id: "org-1" }], setCurrentOrg: vi.fn() };
  return { useOrgsStore: Object.assign((sel: (x: Record<string, unknown>) => unknown) => sel(s), { getState: () => s }) };
});
vi.mock("@/store/places.store", () => {
  const s = { byOrg: { "org-1": { dm: "conv-recordada" } }, remember: vi.fn() };
  return { usePlacesStore: Object.assign((sel: (x: typeof s) => unknown) => sel(s), { getState: () => s }) };
});
vi.mock("@/components/DMSwitcher", () => ({ default: () => <div>la lista</div> }));
vi.mock("@/components/DMThread", () => ({ default: () => <div>el hilo</div> }));

const { default: DirectMessages } = await import("./DirectMessages");

let ancho = 390;
beforeEach(() => {
  open.mockClear();
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => ancho });
});
afterEach(cleanup);

const montar = () =>
  render(
    <MemoryRouter initialEntries={["/dm"]}>
      <DirectMessages />
    </MemoryRouter>,
  );

describe("el último directo recordado", () => {
  it("no se abre solo en el teléfono", () => {
    ancho = 390;
    montar();
    expect(open).not.toHaveBeenCalled();
  });

  it("y sí en el escritorio", () => {
    ancho = 1280;
    montar();
    expect(open).toHaveBeenCalledWith("conv-recordada", "org-1");
  });
});
