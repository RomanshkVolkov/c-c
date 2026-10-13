import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * El buscador de «Nueva conversación».
 *
 * Lo que se arrastra de `DMSwitcher`, que es de donde sale: el selector de la
 * gente tiene que ser una referencia estable —con `current()` como selector
 * la pantalla entró en bucle (React #185) y la app se quedó en blanco—, uno
 * mismo no se ofrece (el servidor rechaza hablar contigo), y tener un hilo en
 * otra org no te esconde de ésta. Mutantes: no excluirse; buscar sólo por
 * nombre; no cerrar al elegir.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { default: NewConversation } = await import("@/components/comms/NewConversation");
const { usePeopleStore } = await import("@/store/people.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useAuthStore } = await import("@/store/auth.store");
const { useDMStore } = await import("@/store/dm.store");

const openWith = vi.fn(async () => "conv-1");
const onOpenChange = vi.fn();
const onPicked = vi.fn();
const mount = () => render(<NewConversation open onOpenChange={onOpenChange} onPicked={onPicked} />);

beforeEach(() => {
  openWith.mockClear();
  onOpenChange.mockClear();
  onPicked.mockClear();
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useAuthStore.setState({ session: { id: "u-yo", username: "yo" }, accessToken: "t" } as never);
  useDMStore.setState({
    openWith,
    // Beto tiene hilo, pero en otra org.
    conversations: [{ conversationId: "c-2", orgId: "org-2", userId: "u-beto", username: "beto", unread: 3 }] as never,
  });
  usePeopleStore.setState({
    byOrg: {
      "org-1": [
        { id: "u-yo", username: "yo" },
        { id: "u-ana", username: "aperez", name: "Ana Pérez" },
        { id: "u-beto", username: "beto" },
      ],
    },
  });
});
afterEach(cleanup);

describe("a quién se ofrece escribir", () => {
  it("se monta sin gente cargada todavía", () => {
    // El estado exacto que entraba en bucle: nada para esta org.
    usePeopleStore.setState({ byOrg: {} });
    expect(() => mount()).not.toThrow();
    expect(screen.getByText("Nobody else in this organization yet.")).toBeTruthy();
  });

  it("no se ofrece a uno mismo", () => {
    mount();
    expect(screen.getByRole("button", { name: /Ana Pérez/ })).toBeTruthy();
    // Por el texto y no por el nombre del botón: ése lleva delante la
    // etiqueta del punto de presencia, y un `/^yo$/` no casaría nunca.
    expect(screen.queryByText("yo")).toBeNull();
  });

  it("tener un hilo en otra org no te esconde de ésta", () => {
    mount();
    expect(screen.getByRole("button", { name: /beto/ })).toBeTruthy();
  });

  it("busca por nombre y por usuario", () => {
    mount();
    const box = screen.getByRole("searchbox", { name: "Find somebody" });
    fireEvent.change(box, { target: { value: "pérez" } });
    expect(screen.getByRole("button", { name: /Ana Pérez/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /beto/ })).toBeNull();
    fireEvent.change(box, { target: { value: "BETO" } });
    expect(screen.getByRole("button", { name: /beto/ })).toBeTruthy();
  });

  it("elegir abre la conversación en esta org, y cierra", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Ana Pérez/ }));
    await waitFor(() => expect(onPicked).toHaveBeenCalled());
    expect(openWith).toHaveBeenCalledWith("org-1", "u-ana");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
