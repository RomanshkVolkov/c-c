import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El menú de cuenta en la versión web: sin actualizador (la versión nueva
 * llega al recargar, y «Comprobar» sólo podía fallar) y sin conectar Claude
 * Code (no hay servidor MCP local). Lo de la cuenta sigue. Mutantes: dejar la
 * fila del actualizador; ofrecer el MCP sin quien lo abra.
 */
vi.stubEnv("VITE_TARGET", "web");
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ logout: vi.fn() }) }));
vi.mock("@/hooks/use-app-version", () => ({ useAppVersion: () => "" }));

const { MemoryRouter } = await import("react-router-dom");
const { default: AccountMenu } = await import("@/components/AccountMenu");
const { useAuthStore } = await import("@/store/auth.store");
const { useConnectionStore } = await import("@/store/connection.store");

beforeEach(() => {
  useAuthStore.setState({ session: { id: "u-1", username: "ana", email: "a@x.io", superadmin: false } } as never);
  useConnectionStore.setState({ stream: "open" } as never);
});
afterEach(cleanup);

describe("el menú de cuenta en la web", () => {
  it("no ofrece actualizaciones ni Claude Code, y sí salir", () => {
    render(
      <MemoryRouter>
        <AccountMenu onChangePassword={() => {}} onNotificationPrefs={() => {}} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByText(/^(check|comprobar|install|instalar)$/i)).toBeNull();
    expect(screen.queryByText(/up to date/)).toBeNull();
    expect(screen.queryByText(/Connect Claude Code/)).toBeNull();
    expect(screen.getByText(/^(log out|cerrar sesión)$/i)).toBeTruthy();
  });
});
