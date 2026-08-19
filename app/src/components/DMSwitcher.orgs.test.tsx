import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * Los directos son de una organización, y la pantalla tiene que decirlo.
 *
 * El reporte: al cambiar de organización aparecían mezclados los usuarios de
 * las dos, y la única forma de ver los de la nueva era recargar la app entera.
 * Eran dos fallos a la vez —el efecto no dependía de la organización, y la
 * lista de conversaciones no se filtraba— y cada uno se comprueba aparte.
 */

let orgActual = "org-1";

const CONVERSACIONES = [
  {
    conversationId: "c-1",
    orgId: "org-1",
    userId: "u-ana",
    username: "ana",
    unread: 0,
    lastMessageAt: null,
  },
  {
    conversationId: "c-2",
    orgId: "org-2",
    userId: "u-beto",
    username: "beto",
    unread: 3,
    lastMessageAt: null,
  },
];

const GENTE: Record<string, { id: string; username: string }[]> = {
  "org-1": [
    { id: "u-ana", username: "ana" },
    { id: "u-beto", username: "beto" },
  ],
  "org-2": [{ id: "u-carmen", username: "carmen" }],
};

const get = vi.fn(async (url: string) => {
  if (url.startsWith("/api/v1/dm")) return { success: true, data: CONVERSACIONES };
  if (url.startsWith("/api/v1/users/search")) {
    const org = new URLSearchParams(url.split("?")[1] ?? "").get("orgId") ?? "";
    return { success: true, data: GENTE[org] ?? [] };
  }
  return { success: true, data: [] };
});

vi.mock("@/lib/api", () => ({
  api: { get: (u: string) => get(u), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => {
  const estado = { accessToken: "t", session: { id: "u-yo", username: "yo" } };
  return {
    useAuthStore: Object.assign((sel: (s: typeof estado) => unknown) => sel(estado), {
      getState: () => estado,
      subscribe: () => () => {},
    }),
  };
});
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: Object.assign(
    (sel: (s: { currentOrgId: string }) => unknown) => sel({ currentOrgId: orgActual }),
    { getState: () => ({ currentOrgId: orgActual }) },
  ),
}));

const { default: DMSwitcher } = await import("@/components/DMSwitcher");
const { useDMStore } = await import("@/store/dm.store");
const { usePeopleStore } = await import("@/store/people.store");

beforeEach(() => {
  orgActual = "org-1";
  useDMStore.setState({ conversations: [], conversationId: null, messages: [] });
  usePeopleStore.setState({ byOrg: {} });
});
afterEach(cleanup);

describe("los directos son de una organización", () => {
  it("no enseña las conversaciones de otra organización", async () => {
    const { container } = render(<DMSwitcher onPicked={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("ana"));
    // beto tiene hilo, pero en org-2: aquí no pinta nada.
    expect(container.textContent).not.toContain("beto (3)");
    expect(container.textContent).not.toContain("99+");
    // Y su contador de no leídos tampoco se cuela.
    expect(container.textContent).not.toContain("3");
  });

  it("tener un hilo en otra organización no te esconde de esta", async () => {
    const { container } = render(<DMSwitcher onPicked={() => {}} />);
    // beto está en org-1 sin hilo aquí y con hilo en org-2. Mirando todas las
    // conversaciones desaparecía de las dos listas: ni arriba, por no ser de
    // aquí, ni abajo, por «ya tener hilo».
    await waitFor(() => expect(container.textContent).toContain("beto"));
    expect(container.textContent).toContain("Start a conversation");
  });

  it("cambiar de organización vuelve a preguntar por su gente", async () => {
    const { rerender, container } = render(<DMSwitcher onPicked={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("ana"));

    orgActual = "org-2";
    rerender(<DMSwitcher onPicked={() => {}} />);

    // Sin esto había que recargar la app: el efecto sólo dependía de acciones
    // de zustand, que nunca cambian de identidad.
    await waitFor(() => expect(container.textContent).toContain("carmen"));
    expect(container.textContent).not.toContain("ana");
  });

  it("cambiar de organización cierra el hilo abierto", async () => {
    const { rerender } = render(<DMSwitcher onPicked={() => {}} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    useDMStore.setState({ conversationId: "c-1" });

    orgActual = "org-2";
    rerender(<DMSwitcher onPicked={() => {}} />);
    await waitFor(() => expect(useDMStore.getState().conversationId).toBeNull());
  });

  it("volver a montar sin cambiar de organización no cierra nada", async () => {
    const { unmount } = render(<DMSwitcher onPicked={() => {}} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    useDMStore.setState({ conversationId: "c-1" });
    unmount();

    render(<DMSwitcher onPicked={() => {}} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    // Ir a Servers y volver remonta esta pantalla. Cerrar el hilo ahí sería
    // perder de vista una conversación que nadie pidió cerrar.
    expect(useDMStore.getState().conversationId).toBe("c-1");
  });
});
