import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

/**
 * El menú de abajo del teléfono (11-oct-2026). Mutantes: pintarlo en el
 * escritorio o sin sesión; no limpiar el ámbito de Mi trabajo; Comunicación a
 * una sección fija; el globo con sólo una de las dos cuentas; no esconderlo en
 * una conversación o con el teclado; el botón activo equivocado.
 */
const { setScope, unread, dm, masProps } = vi.hoisted(() => ({
  setScope: vi.fn(),
  unread: { channels: 0, dms: 0 },
  dm: { conversationId: null as string | null },
  masProps: { open: false },
}));
vi.mock("@/store/mywork.store", () => ({
  useMyWorkStore: (sel: (s: unknown) => unknown) => sel({ setScope }),
}));
vi.mock("@/hooks/use-comms-unread", () => ({ useCommsUnread: () => unread }));
vi.mock("@/store/dm.store", () => ({
  useDMStore: (sel: (s: unknown) => unknown) => sel({ conversationId: dm.conversationId }),
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ accessToken: "t" }),
}));
vi.mock("@/components/voice/VoiceMini", () => ({ default: () => null }));
vi.mock("@/components/mobile/MoreSheet", () => ({
  default: ({ open }: { open: boolean }) => {
    masProps.open = open;
    return open ? <div>la hoja</div> : null;
  },
}));

const { default: MobileTabBar } = await import("./MobileTabBar");
const { useLayoutStore } = await import("@/store/layout.store");

function Donde() {
  const l = useLocation();
  return <output data-testid="ruta">{l.pathname + l.search}</output>;
}
const montar = (ruta: string) =>
  render(
    <MemoryRouter initialEntries={[ruta]}>
      <MobileTabBar />
      <Donde />
    </MemoryRouter>,
  );
const ruta = () => screen.getByTestId("ruta").textContent;
const barra = () => screen.queryByTestId("mobile-tab-bar");

let ancho = 390;
let visible = 800;
beforeEach(() => {
  ancho = 390;
  visible = 800;
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => ancho });
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 800 });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    get: () => ({ height: visible, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  unread.channels = 0;
  unread.dms = 0;
  dm.conversationId = null;
  setScope.mockClear();
  useLayoutStore.setState({ comms: "/chat" });
});
afterEach(cleanup);

describe("el menú de abajo del teléfono", () => {
  it("no existe en pantalla ancha", () => {
    ancho = 1280;
    montar("/my-work");
    expect(barra()).toBeNull();
  });

  it("tres botones, y el de donde estás marcado", () => {
    montar("/my-work");
    const botones = screen.getAllByRole("button");
    expect(botones.map((b) => b.textContent)).toEqual(["My work", "Messages", "More"]);
    expect(botones[0].getAttribute("aria-current")).toBe("page");
    cleanup();
    montar("/dm");
    expect(screen.getByRole("button", { name: /Messages/ }).getAttribute("aria-current")).toBe("page");
    cleanup();
    montar("/docs");
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-current")).toBe("page");
  });

  it("Mi trabajo es todo él, sin el filtro de la última lista", () => {
    montar("/docs");
    fireEvent.click(screen.getByRole("button", { name: "My work" }));
    expect(setScope).toHaveBeenCalledWith(null);
    expect(ruta()).toBe("/my-work");
  });

  it("Comunicación vuelve a la sección en la que estuviste", () => {
    useLayoutStore.setState({ comms: "/dm" });
    montar("/my-work");
    fireEvent.click(screen.getByRole("button", { name: /Messages/ }));
    expect(ruta()).toBe("/dm");
  });

  it("su globo suma canales y directos", () => {
    unread.channels = 3;
    unread.dms = 2;
    montar("/my-work");
    expect(screen.getByTestId("tab-badge").textContent).toBe("5");
  });

  it("se esconde dentro de una conversación, y vuelve en la lista", () => {
    montar("/chat?space=sp-1");
    expect(barra()).toBeNull();
    cleanup();
    montar("/chat");
    expect(barra()).not.toBeNull();
    cleanup();
    dm.conversationId = "c-1";
    montar("/dm");
    expect(barra()).toBeNull();
  });

  it("se esconde con el teclado fuera", () => {
    visible = 450;
    montar("/my-work");
    expect(barra()).toBeNull();
  });

  it("Más abre la hoja", () => {
    montar("/my-work");
    expect(screen.queryByText("la hoja")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText("la hoja")).toBeTruthy();
  });
});
