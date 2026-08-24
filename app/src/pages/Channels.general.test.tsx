import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SpaceTree } from "@/types/task";

/**
 * La sala general de la organización, en la lista de canales.
 *
 * No es una entidad aparte: es un espacio con `kind: "general"`, que ya trae
 * canal y llamada por existir. Lo único que la distingue aquí es **dónde se
 * pinta** —anclada arriba, separada del resto— y que quien administra puede
 * abrirla cuando todavía no está.
 *
 * Lo que se prueba es esa decisión, no el pintado: el orden, quién ve el botón,
 * y a dónde va quien entra sin haber elegido canal.
 */

const { tree, abrirSalaGeneral, orgActual, sesion } = vi.hoisted(() => ({
  tree: { current: [] as SpaceTree[] },
  abrirSalaGeneral: vi.fn(),
  orgActual: { current: { id: "org-1", name: "Guz", role: "member" } as Record<string, unknown> },
  sesion: { current: { superadmin: false } as Record<string, unknown> },
}));

vi.mock("@/store/tasks.store", () => ({
  useTasksStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ tree: tree.current, abrirSalaGeneral, unread: {} }),
    { setState: vi.fn(), getState: () => ({ tree: tree.current }) },
  ),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ currentOrgId: "org-1", currentOrg: () => orgActual.current }),
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ session: sesion.current }),
}));
vi.mock("@/store/chat.store", () => ({
  useChatStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ unreadBySpace: {}, fetchUnread: () => Promise.resolve(), following: {} }),
    { setState: vi.fn(), getState: () => ({}) },
  ),
}));
vi.mock("@/store/voice.store", () => ({
  useVoice: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ ocupacion: {}, refrescarOcupacion: vi.fn() }),
    { getState: () => ({}) },
  ),
}));
vi.mock("@/components/chat/ChannelView", () => ({ default: () => <div>hilo</div> }));
vi.mock("@/components/voice/useEncogerEnLlamada", () => ({ useEncogerEnLlamada: () => false }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { params } = vi.hoisted(() => ({ params: { current: new URLSearchParams() } }));
vi.mock("react-router-dom", () => ({
  useSearchParams: () => [params.current, vi.fn()] as const,
}));

const { default: Channels } = await import("@/pages/Channels");

const espacio = (id: string, name: string, kind?: string) =>
  ({ id, orgId: "org-1", name, color: "", kind, folders: [], lists: [], people: [] }) as unknown as SpaceTree;

beforeEach(() => {
  abrirSalaGeneral.mockResolvedValue(undefined);
  params.current = new URLSearchParams();
  orgActual.current = { id: "org-1", name: "Guz", role: "member" };
  sesion.current = { superadmin: false };
});
afterEach(cleanup);

describe("la sala general en la lista", () => {
  it("va la primera, por delante de los canales de trabajo", () => {
    tree.current = [espacio("esp-1", "Boaty"), espacio("esp-g", "General", "general")];
    render(<Channels />);
    const nombres = [...document.querySelectorAll("nav button span")]
      .map((e) => e.textContent)
      .filter((t) => t === "General" || t === "Boaty");
    expect(nombres[0]).toBe("General");
  });

  // Entrar sin haber elegido nada tiene que caer en la sala de todos, no en el
  // primer espacio que devuelva el servidor.
  it("es el canal por defecto de quien no ha elegido", () => {
    tree.current = [espacio("esp-1", "Boaty"), espacio("esp-g", "General", "general")];
    render(<Channels />);
    const activo = document.querySelector("nav button.bg-accent");
    expect(activo?.textContent).toContain("General");
  });

  it("y si eliges un canal, manda tu elección", () => {
    params.current = new URLSearchParams({ space: "esp-1" });
    tree.current = [espacio("esp-1", "Boaty"), espacio("esp-g", "General", "general")];
    render(<Channels />);
    expect(document.querySelector("nav button.bg-accent")?.textContent).toContain("Boaty");
  });
});

describe("abrirla es del admin", () => {
  it("un miembro corriente no ve el botón", () => {
    tree.current = [espacio("esp-1", "Boaty")];
    render(<Channels />);
    expect(screen.queryByText("Open a general room")).toBeNull();
  });

  it("el admin sí", () => {
    orgActual.current = { id: "org-1", name: "Guz", role: "admin" };
    tree.current = [espacio("esp-1", "Boaty")];
    render(<Channels />);
    expect(screen.getByText("Open a general room")).toBeTruthy();
  });

  it("y el superadmin también, aunque no sea miembro", () => {
    sesion.current = { superadmin: true };
    tree.current = [espacio("esp-1", "Boaty")];
    render(<Channels />);
    expect(screen.getByText("Open a general room")).toBeTruthy();
  });

  // Ofrecer abrirla cuando ya está sería ofrecer nada: el servidor devuelve la
  // misma, pero el botón habría mentido sobre lo que hace.
  it("nadie lo ve cuando la sala ya existe", () => {
    orgActual.current = { id: "org-1", name: "Guz", role: "admin" };
    tree.current = [espacio("esp-g", "General", "general")];
    render(<Channels />);
    expect(screen.queryByText("Open a general room")).toBeNull();
  });

  it("pulsarlo la abre en la organización de la pestaña", async () => {
    orgActual.current = { id: "org-1", name: "Guz", role: "admin" };
    tree.current = [espacio("esp-1", "Boaty")];
    render(<Channels />);
    fireEvent.click(screen.getByText("Open a general room"));
    await vi.waitFor(() => expect(abrirSalaGeneral).toHaveBeenCalledWith("org-1"));
  });
});
