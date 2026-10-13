import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Los directos del panel de Comunicación.
 *
 * Son de una organización, y la lista tiene que decirlo: el servidor devuelve
 * las conversaciones de todas, y mezclarlas ponía en la misma columna gente de
 * dos clientes. La abierta se marca sólo si es de esta org —el mismo sello con
 * el que la página decide si la pinta—. El filtro casa nombre **y** usuario:
 * se busca a la gente por cómo se llama, y se la menciona por su usuario.
 * Mutantes: quitar el filtro de org; ignorar `conversationOrgId`; casar sólo
 * el usuario; abrir sin ir a `/dm`.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { default: DirectsSection } = await import("@/components/comms/DirectsSection");
const { useDMStore } = await import("@/store/dm.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useAuthStore } = await import("@/store/auth.store");
const { useLayoutStore } = await import("@/store/layout.store");
const { usePeopleStore } = await import("@/store/people.store");

let where = "";
function Where() {
  const l = useLocation();
  where = l.pathname;
  return null;
}

const mount = (url = "/dm", filter = "") =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <DirectsSection filter={filter} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const recently = new Date().toISOString();
const open = vi.fn(async () => {});

beforeEach(() => {
  open.mockClear();
  useOrgsStore.setState({ currentOrgId: "org-b" } as never);
  useAuthStore.setState({ session: { id: "u-yo", username: "yo" }, accessToken: "t" } as never);
  usePeopleStore.setState({ byOrg: {} });
  useLayoutStore.setState({ expanded: {} });
  useDMStore.setState({
    open,
    conversationId: null,
    conversationOrgId: null,
    conversations: [
      { conversationId: "c-1", orgId: "org-b", userId: "u-ana", username: "aperez", name: "Ana Pérez", unread: 0, lastSeenAt: recently },
      { conversationId: "c-2", orgId: "org-b", userId: "u-luis", username: "luis", unread: 3 },
      { conversationId: "c-3", orgId: "org-a", userId: "u-otra", username: "otra", name: "De otra org", unread: 7 },
    ] as never,
  });
});
afterEach(cleanup);

describe("las conversaciones", () => {
  it("sólo las de esta org, con sus no leídos", () => {
    mount();
    expect(screen.getByRole("button", { name: /Ana Pérez/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /luis/ }).textContent).toContain("3");
    expect(screen.queryByText("De otra org")).toBeNull();
    expect(document.body.textContent).not.toContain("7");
  });

  it("con quién anda por aquí", () => {
    mount();
    expect(document.querySelectorAll('[aria-label="active recently"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-label="not active recently"]')).toHaveLength(1);
  });

  it("la abierta se marca si es de esta org", () => {
    useDMStore.setState({ conversationId: "c-2", conversationOrgId: "org-b" });
    mount();
    expect(document.querySelector('[aria-current="page"]')?.textContent).toContain("luis");
  });

  // El mismo id abierto, pero sellado en otra org: la página no lo pinta, así
  // que la lista no puede decir que está en pantalla.
  it("y no si la abierta es de otra org", () => {
    useDMStore.setState({ conversationId: "c-2", conversationOrgId: "org-a" });
    mount();
    expect(document.querySelector('[aria-current="page"]')).toBeNull();
  });

  it("pulsar una la abre y lleva a Directos", () => {
    mount("/chat");
    fireEvent.click(screen.getByRole("button", { name: /luis/ }));
    expect(open).toHaveBeenCalledWith("c-2", "org-b");
    expect(where).toBe("/dm");
  });
});

describe("el filtro", () => {
  it("casa por nombre", () => {
    mount("/dm", "pérez");
    expect(screen.getByRole("button", { name: /Ana Pérez/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /luis/ })).toBeNull();
  });

  it("y por usuario", () => {
    mount("/dm", "APEREZ");
    expect(screen.getByRole("button", { name: /Ana Pérez/ })).toBeTruthy();
  });

  it("no encuentra a quien es de otra org", () => {
    mount("/dm", "otra");
    expect(document.querySelector("section")).toBeNull();
  });
});

describe("nueva conversación", () => {
  it("abre el buscador con la gente de la org", () => {
    usePeopleStore.setState({ byOrg: { "org-b": [{ id: "u-carmen", username: "carmen" }] } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: /carmen/ })).toBeTruthy();
  });
});

describe("la sección", () => {
  it("se pliega y se recuerda por org", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Direct messages/ }));
    expect(screen.queryByRole("button", { name: /Ana Pérez/ })).toBeNull();
    // Luis tiene tres sin leer: plegada, sigue a la vista.
    expect(screen.getByRole("button", { name: /luis/ })).toBeTruthy();
    expect(useLayoutStore.getState().expanded["org-b/comms"]).toEqual({ "section:directs": false });
  });

  // Ir a otra pantalla y volver remonta la lista. Cerrar el hilo ahí sería
  // perder de vista una conversación que nadie pidió cerrar.
  it("volver a montarla sin cambiar de org no cierra nada", () => {
    useDMStore.setState({ conversationId: "c-1", conversationOrgId: "org-b" });
    const { unmount } = mount();
    unmount();
    mount();
    expect(useDMStore.getState().conversationId).toBe("c-1");
  });
});
