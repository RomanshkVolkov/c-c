import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * El directo de otra org no se pinta aquí, lo deje abierto quien lo deje.
 *
 * `store/org-switch.ts` lo cierra al cambiar de org; esto es lo que garantiza
 * que, si algo se le escapa —un camino nuevo que cambie la org, un enlace—,
 * siga sin verse. Es la mitad que aguanta sola.
 */

let estado: Record<string, unknown> = {};
vi.mock("@/store/dm.store", () => ({
  useDMStore: (sel: (s: Record<string, unknown>) => unknown) => sel(estado),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ currentOrgId: "org-b" }),
}));
vi.mock("@/components/DMSwitcher", () => ({ default: () => null }));
vi.mock("@/components/DMThread", () => ({ default: () => <p>el hilo</p> }));

const { default: DirectMessages } = await import("./DirectMessages");
const { usePlacesStore } = await import("@/store/places.store");

const pantalla = () =>
  render(
    <MemoryRouter initialEntries={["/dm"]}>
      <DirectMessages />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  usePlacesStore.setState({ byOrg: {} });
});

const base = { open: vi.fn(), openWith: vi.fn(), close: vi.fn() };

describe("el directo abierto y la org en pantalla", () => {
  it("uno de otra org no se pinta", () => {
    estado = { ...base, conversationId: "c-1", conversationOrgId: "org-a" };
    pantalla();
    expect(screen.queryByText("el hilo")).toBeNull();
  });

  it("uno del que no se sabe la org, tampoco", () => {
    estado = { ...base, conversationId: "c-1", conversationOrgId: null };
    pantalla();
    expect(screen.queryByText("el hilo")).toBeNull();
  });

  it("uno de esta org, sí", () => {
    estado = { ...base, conversationId: "c-1", conversationOrgId: "org-b" };
    pantalla();
    expect(screen.getByText("el hilo")).toBeTruthy();
  });

  // Cada org recuerda dónde estabas: volver a Direct messages sin pedir nada
  // reabre el último directo de esta org.
  it("sin nada abierto ni pedido, se reabre el último directo de esta org", async () => {
    const open = vi.fn(async () => {});
    usePlacesStore.getState().remember("org-b", { dm: "c-5" });
    usePlacesStore.getState().remember("org-a", { dm: "c-9" });
    estado = { ...base, open, conversationId: null, conversationOrgId: null };
    pantalla();
    await waitFor(() => expect(open).toHaveBeenCalledWith("c-5", "org-b"));
    expect(open).not.toHaveBeenCalledWith("c-9", expect.anything());
  });
});
