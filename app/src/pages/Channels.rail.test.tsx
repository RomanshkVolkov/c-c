import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * La lista de canales se pliega a un riel con las iniciales de cada canal.
 *
 * Abierta se come 240px que en una tablet son la conversación (9-oct-2026).
 * Plegada sigue diciendo qué canal es cuál (iniciales, no un `#` repetido),
 * cuántos sin leer tiene y si hay gente en su voz. Se recuerda; en el teléfono
 * no se pliega, que ahí ya se ve una cosa u otra.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/components/chat/ChannelView", () => ({
  default: ({ spaceName }: { spaceName: string }) => <div>viendo {spaceName}</div>,
}));
let movil = false;
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => movil }));

const { MemoryRouter } = await import("react-router-dom");
const { default: Channels } = await import("@/pages/Channels");
const { useTasksStore } = await import("@/store/tasks.store");
const { useChatStore } = await import("@/store/chat.store");
const { useVoice } = await import("@/store/voice.store");
const { useLayoutStore } = await import("@/store/layout.store");
const { SidebarProvider } = await import("@/components/ui/sidebar");

const arbol = [
  { id: "sp-1", orgId: "o", name: "Pixel solidari", color: "#888", folders: [], lists: [] },
  { id: "sp-2", orgId: "o", name: "Eleva", color: "#888", folders: [], lists: [] },
];

beforeEach(() => {
  movil = false;
  useTasksStore.setState({ tree: arbol } as never);
  useChatStore.setState({ unreadBySpace: { "sp-2": 4 }, panelOpen: false, spaceId: null } as never);
  useVoice.setState({ ocupacion: { "sp-1": [{ identity: "u-1", name: "Ana" }] }, refrescarOcupacion: vi.fn() } as never);
  useLayoutStore.setState({ collapsed: {} });
});
afterEach(cleanup);

const montar = (url = "/chat?space=sp-1") =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SidebarProvider>
        <Channels />
      </SidebarProvider>
    </MemoryRouter>,
  );

describe("la lista de canales plegada", () => {
  it("plegar la deja en un riel con las iniciales, y se recuerda", () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Collapse the list" }));
    expect(useLayoutStore.getState().collapsed.channels).toBe(true);
    const eleva = screen.getByRole("button", { name: "Eleva" });
    expect(eleva.textContent).toContain("EL");
    expect(screen.getByRole("button", { name: "Pixel solidari" }).textContent).toContain("PS");
  });

  it("el riel dice cuál está abierto, cuántos sin leer y si hay gente en la voz", () => {
    useLayoutStore.setState({ collapsed: { channels: true } });
    montar();
    expect(screen.getByRole("button", { name: "Pixel solidari" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Eleva" }).textContent).toContain("4");
    expect(screen.getByRole("button", { name: "Pixel solidari" }).querySelector('[data-live="true"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Eleva" }).querySelector('[data-live="true"]')).toBeNull();
  });

  it("pulsar uno del riel abre ese canal", () => {
    useLayoutStore.setState({ collapsed: { channels: true } });
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Eleva" }));
    expect(screen.getByText("viendo Eleva")).toBeTruthy();
  });

  it("desplegar vuelve a la lista entera", () => {
    useLayoutStore.setState({ collapsed: { channels: true } });
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Expand the list" }));
    expect(useLayoutStore.getState().collapsed.channels).toBe(false);
    expect(screen.queryByRole("button", { name: "Eleva" })).toBeNull();
  });

  it("en el teléfono no se pliega", () => {
    movil = true;
    useLayoutStore.setState({ collapsed: { channels: true } });
    montar("/chat");
    expect(screen.queryByRole("button", { name: "Expand the list" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Eleva" })).toBeNull();
  });
});
