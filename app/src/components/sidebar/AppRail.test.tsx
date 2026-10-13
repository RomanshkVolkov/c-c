import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El riel: cuatro módulos con nombre, el activo marcado, y cada icono te
 * devuelve a donde estabas en él.
 *
 * Mutantes: `aria-current` en todos; ignorar `lastRoute` (el icono siempre a
 * la portada); navegar en vez de abrir el panel al pulsar el activo plegado;
 * enseñar los cuatro sin sesión.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}`, revokeSession: vi.fn() }));

const { MemoryRouter, useLocation } = await import("react-router-dom");
const { default: AppSidebar } = await import("@/components/AppSidebar");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { useAuthStore } = await import("@/store/auth.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useLayoutStore } = await import("@/store/layout.store");

let where = "";
function Where() {
  const l = useLocation();
  where = l.pathname + l.search;
  return null;
}

/** Montado como en `AppLayout`: el provider controlado por el store. */
function Shell() {
  const open = useLayoutStore((s) => s.panelOpen);
  const setOpen = useLayoutStore((s) => s.setPanelOpen);
  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <AppSidebar />
      <Where />
    </SidebarProvider>
  );
}

const mount = (at: string) =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <ConfirmProvider>
        <PromptProvider>
          <Shell />
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

const railButton = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  api.get.mockResolvedValue({ success: true, data: [] });
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useAuthStore.setState({
    session: { id: "u-1", username: "ana", superadmin: false },
    accessToken: "t",
  } as never);
  useLayoutStore.setState({ activeModule: "work", lastRoute: {}, panelOpen: true, expanded: {} });
});
afterEach(cleanup);

describe("el riel", () => {
  it("lleva los cuatro módulos con su nombre, y marca sólo el de la ruta", () => {
    mount("/docs");
    const current = ["Work", "Documentation", "Communication", "Platform"].filter(
      (n) => railButton(n).getAttribute("aria-current") === "page",
    );
    expect(current).toEqual(["Documentation"]);
  });

  it("en organización no marca ningún módulo, y el panel sigue con el último", () => {
    useLayoutStore.setState({ activeModule: "comms" });
    mount("/organization");
    expect(railButton("Communication").getAttribute("aria-current")).toBeNull();
    expect(railButton("Organization").getAttribute("aria-current")).toBe("page");
    // La cabecera del panel nombra el módulo que sigue al mando.
    expect(screen.getByRole("heading", { name: "Communication" })).toBeTruthy();
  });

  it("un módulo te devuelve a donde estabas en él", () => {
    useLayoutStore.setState({ lastRoute: { comms: "/chat?space=sp-2" } });
    mount("/my-work");
    fireEvent.click(railButton("Communication"));
    expect(where).toBe("/chat?space=sp-2");
  });

  it("sin sitio recordado, a su portada", () => {
    mount("/my-work");
    fireEvent.click(railButton("Communication"));
    expect(where).toBe("/chat");
  });

  it("pulsar el activo con el panel plegado lo abre, sin moverte", () => {
    mount("/my-work?x=1");
    act(() => useLayoutStore.setState({ panelOpen: false }));
    fireEvent.click(railButton("Work"));
    expect(useLayoutStore.getState().panelOpen).toBe(true);
    expect(where).toBe("/my-work?x=1");
  });

  it("al entrar en una ruta, el módulo manda y la ruta se apunta", () => {
    mount("/servers/abc/services");
    expect(useLayoutStore.getState().activeModule).toBe("platform");
    expect(useLayoutStore.getState().lastRoute.platform).toBe("/servers/abc/services");
  });

  it("⌘B pliega el panel y el riel se queda", () => {
    mount("/my-work");
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(useLayoutStore.getState().panelOpen).toBe(false);
    expect(railButton("Work")).toBeTruthy();
  });
});

describe("el riel sin sesión", () => {
  it("sólo Plataforma y entrar", () => {
    useAuthStore.setState({ session: null, accessToken: null } as never);
    mount("/devtools/image");
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Communication" })).toBeNull();
    expect(railButton("Platform")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Login" }).length).toBeGreaterThan(0);
  });
});
