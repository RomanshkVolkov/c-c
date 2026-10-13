import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Plataforma: los servidores uno a uno con su punto de estado, y lo demás.
 *
 * Mutantes: pintar todos los puntos en verde; Usuarios sin el filtro de
 * superadmin; la fila de un servidor que no navega a su pantalla.
 */

const servers = vi.hoisted(() => ({
  list: [] as { id: string; name: string; status: string }[],
}));
vi.mock("@/hooks/use-servers", () => ({ useServers: () => ({ servers: servers.list }) }));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter, useLocation } = await import("react-router-dom");
const { default: PlatformPanel } = await import("@/components/sidebar/panels/PlatformPanel");
const { useAuthStore } = await import("@/store/auth.store");

let where = "";
function Where() {
  where = useLocation().pathname;
  return null;
}

const mount = (at = "/dashboard") =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <PlatformPanel />
      <Where />
    </MemoryRouter>,
  );

beforeEach(() => {
  servers.list = [
    { id: "s-1", name: "contabo", status: "online" },
    { id: "s-2", name: "valkey", status: "offline" },
  ];
  useAuthStore.setState({
    session: { id: "u-1", username: "ana", superadmin: false },
    accessToken: "t",
  } as never);
});
afterEach(cleanup);

describe("el panel de Plataforma", () => {
  it("lista cada servidor con lo que dice su punto", () => {
    mount();
    expect(screen.getByText("contabo")).toBeTruthy();
    // El nombre y el color, los dos: el punto se lee de un vistazo, y uno
    // verde que dice «Offline» sólo se descubre pasando el ratón. Por la
    // clase porque jsdom no aplica CSS.
    expect(screen.getByRole("img", { name: "Online" }).className).toContain("bg-success");
    expect(screen.getByRole("img", { name: "Offline" }).className).toContain("bg-destructive");
  });

  it("un servidor lleva a su pantalla, y marcado dentro de ella", () => {
    mount("/servers/s-2/services");
    expect(screen.getByText("valkey").closest("button")?.getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByText("contabo"));
    expect(where).toBe("/servers/s-1");
  });

  it("Usuarios, sólo para superadmin", () => {
    mount();
    expect(screen.queryByText("Users")).toBeNull();
    cleanup();
    useAuthStore.setState({ session: { id: "u-1", username: "ana", superadmin: true } } as never);
    mount();
    expect(screen.getByText("Users")).toBeTruthy();
  });

  it("sin sesión sólo las herramientas de invitado", () => {
    useAuthStore.setState({ session: null, accessToken: null } as never);
    mount("/devtools/image");
    expect(screen.queryByText("Servers")).toBeNull();
    expect(screen.queryByText("Activity")).toBeNull();
    expect(screen.getByText("Image")).toBeTruthy();
    expect(screen.queryByText("Requests")).toBeNull();
  });
});
