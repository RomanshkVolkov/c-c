import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * The open channel lives in the address, and says so to the notifier.
 *
 * Two things worth pinning down. A channel you are reading is a place you can
 * link to and come back to, which it was not while it lived in a store. And the
 * screen has to announce which channel is on screen, because the rule "don't
 * notify me about the messages I am watching arrive" used to be spelled "is the
 * chat panel open on this space" — with the panel gone that would be false
 * forever, and every message you saw appear would also buzz.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/components/chat/ChannelView", () => ({
  default: ({ spaceName }: { spaceName: string }) => <div>viendo {spaceName}</div>,
}));

const { MemoryRouter } = await import("react-router-dom");
const { default: Channels } = await import("@/pages/Channels");
const { useTasksStore } = await import("@/store/tasks.store");
const { useChatStore } = await import("@/store/chat.store");

const arbol = [
  { id: "sp-1", orgId: "o", name: "Uno", color: "#888", folders: [], lists: [] },
  { id: "sp-2", orgId: "o", name: "Dos", color: "#888", folders: [], lists: [] },
];

beforeEach(() => {
  useTasksStore.setState({ tree: arbol } as never);
  useChatStore.setState({ unreadBySpace: {}, panelOpen: false, spaceId: null } as never);
});
afterEach(cleanup);

// `SidebarProvider` porque la pantalla vive dentro del armazón —`AppLayout` lo
// envuelve todo— y encoge el rail cuando alguien comparte pantalla.
const { SidebarProvider } = await import("@/components/ui/sidebar");

const montar = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SidebarProvider>
        <Channels />
      </SidebarProvider>
    </MemoryRouter>,
  );

describe("la pantalla de canales", () => {
  it("abre el canal que dice la dirección", () => {
    montar("/chat?space=sp-2");
    expect(screen.getByText("viendo Dos")).toBeTruthy();
  });

  it("sin canal en la dirección abre el primero, en vez de no enseñar nada", () => {
    montar("/chat");
    expect(screen.getByText("viendo Uno")).toBeTruthy();
  });

  it("declara qué canal está a la vista, para que no te avisen de lo que ya estás leyendo", () => {
    montar("/chat?space=sp-2");
    expect(useChatStore.getState().spaceId).toBe("sp-2");
    expect(useChatStore.getState().panelOpen).toBe(true);
  });

  it("y al salir deja de declararlo", () => {
    const { unmount } = montar("/chat?space=sp-2");
    unmount();
    expect(useChatStore.getState().panelOpen).toBe(false);
  });
});
