import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Canales en un teléfono: la lista **o** la conversación, no las dos.
 *
 * Al lado de la lista, la conversación quedaba de un tercio de pantalla y se
 * leía palabra a palabra (captura de jose, 5-oct-2026). Lo que se fija:
 * entrar enseña la lista —no el último canal, como en el escritorio—; elegir
 * uno enseña sólo la conversación, con flecha para volver; y con la lista en
 * pantalla no se está «mirando» ningún canal, así que sus mensajes avisan.
 * Mutantes: no esconder la lista; abrir el canal recordado en el teléfono;
 * declarar el canal a la vista estando en la lista.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/components/chat/ChannelView", () => ({
  default: ({ spaceName, onBack }: { spaceName: string; onBack?: () => void }) => (
    <div>
      viendo {spaceName}
      {onBack && <button onClick={onBack}>volver</button>}
    </div>
  ),
}));

const { MemoryRouter } = await import("react-router-dom");
const { default: Channels } = await import("@/pages/Channels");
const { useTasksStore } = await import("@/store/tasks.store");
const { useChatStore } = await import("@/store/chat.store");
const { SidebarProvider } = await import("@/components/ui/sidebar");

const arbol = [
  { id: "sp-1", orgId: "o", name: "Uno", color: "#888", folders: [], lists: [] },
  { id: "sp-2", orgId: "o", name: "Dos", color: "#888", folders: [], lists: [] },
];

const montar = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SidebarProvider>
        <Channels />
      </SidebarProvider>
    </MemoryRouter>,
  );

/** El rótulo de la columna: si se ve, la lista está en pantalla. */
const listaVisible = () => !screen.getByText(/^(channels|canales)$/i).closest("aside")!.classList.contains("hidden");

let ancho = 1280;
beforeEach(() => {
  ancho = 390;
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => ancho });
  useTasksStore.setState({ tree: arbol } as never);
  useChatStore.setState({ unreadBySpace: {}, panelOpen: false, spaceId: null } as never);
});
afterEach(cleanup);

describe("canales en un teléfono", () => {
  it("entrar enseña la lista, no un canal", () => {
    montar("/chat");
    expect(listaVisible()).toBe(true);
    expect(screen.queryByText(/^viendo/)).toBeNull();
    expect(useChatStore.getState().panelOpen).toBe(false);
  });

  it("elegir uno enseña sólo la conversación, y volver regresa a la lista", () => {
    montar("/chat?space=sp-2");
    expect(screen.getByText("viendo Dos")).toBeTruthy();
    expect(listaVisible()).toBe(false);
    fireEvent.click(screen.getByText("volver"));
    expect(listaVisible()).toBe(true);
    expect(screen.queryByText(/^viendo/)).toBeNull();
  });

  it("en el escritorio sigue todo junto, y sin flecha de volver", () => {
    ancho = 1280;
    montar("/chat");
    expect(listaVisible()).toBe(true);
    expect(screen.getByText("viendo Uno")).toBeTruthy();
    expect(screen.queryByText("volver")).toBeNull();
  });
});
