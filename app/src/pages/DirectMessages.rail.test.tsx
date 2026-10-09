import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * La lista de directos se pliega como la de canales: un riel con las iniciales
 * de cada persona, sus no leídos, y un botón para buscar a alguien nuevo que
 * despliega la lista. Plegada no se monta `DMSwitcher` —quien pide las
 * conversaciones—, así que el riel las pide él.
 */

const fetchConversations = vi.fn(async () => {});
const open = vi.fn(async () => {});
let estado: Record<string, unknown> = {};
vi.mock("@/store/dm.store", () => ({
  useDMStore: Object.assign((sel: (s: Record<string, unknown>) => unknown) => sel(estado), {
    getState: () => estado,
  }),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ currentOrgId: "org-b" }),
}));
vi.mock("@/components/DMSwitcher", () => ({ default: () => <p>la lista entera</p> }));
vi.mock("@/components/DMThread", () => ({ default: () => <p>el hilo</p> }));

const { default: DirectMessages } = await import("./DirectMessages");
const { useLayoutStore } = await import("@/store/layout.store");

beforeEach(() => {
  fetchConversations.mockClear();
  open.mockClear();
  estado = {
    open,
    openWith: vi.fn(),
    close: vi.fn(),
    fetchConversations,
    conversationId: "c-1",
    conversationOrgId: "org-b",
    conversations: [
      { conversationId: "c-1", orgId: "org-b", username: "ana", name: "Ana Pérez", unread: 0 },
      { conversationId: "c-2", orgId: "org-b", username: "luis", name: "", unread: 3 },
      { conversationId: "c-3", orgId: "org-a", username: "otra", name: "De otra org", unread: 1 },
    ],
  };
  useLayoutStore.setState({ collapsed: { dms: true } });
});
afterEach(cleanup);

const pantalla = () =>
  render(
    <MemoryRouter initialEntries={["/dm"]}>
      <DirectMessages />
    </MemoryRouter>,
  );

describe("la lista de directos plegada", () => {
  it("un riel con las iniciales de cada persona de esta org, y sus no leídos", () => {
    pantalla();
    expect(screen.getByRole("button", { name: "Ana Pérez" }).textContent).toContain("AP");
    expect(screen.getByRole("button", { name: "Ana Pérez" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "luis" }).textContent).toContain("3");
    expect(screen.queryByRole("button", { name: "De otra org" })).toBeNull();
    expect(screen.queryByText("la lista entera")).toBeNull();
  });

  it("pide las conversaciones, porque plegada nadie más las pide", () => {
    pantalla();
    expect(fetchConversations).toHaveBeenCalled();
  });

  it("pulsar una la abre", () => {
    pantalla();
    fireEvent.click(screen.getByRole("button", { name: "luis" }));
    expect(open).toHaveBeenCalledWith("c-2", "org-b");
  });

  it("buscar a alguien nuevo despliega la lista", () => {
    pantalla();
    fireEvent.click(screen.getByRole("button", { name: "Find somebody" }));
    expect(useLayoutStore.getState().collapsed.dms).toBe(false);
    expect(screen.getByText("la lista entera")).toBeTruthy();
  });
});
