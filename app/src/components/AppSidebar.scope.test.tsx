import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Entrar a «My work» por su fila del menú es pedirlo entero.
 *
 * El filtro lo pone pulsar una lista en el árbol, y hasta ahora la única forma
 * de quitárselo era la píldora de la propia pantalla. Quien venía por aquí
 * —después de haber pulsado una lista hace rato— se encontraba «su trabajo»
 * enseñando una lista sola, que se lee como que no tiene nada más.
 *
 * La regla, en las palabras con las que se pidió: si entro a «mi trabajo»,
 * muéstrame todo; si entro por una lista, muéstrame la que pulsé.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));

const { MemoryRouter } = await import("react-router-dom");
const { default: AppSidebar } = await import("@/components/AppSidebar");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { useAuthStore } = await import("@/store/auth.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useMyWorkStore } = await import("@/store/mywork.store");

const ACOTADO = { kind: "list" as const, id: "li-1", name: "Pendientes", orgId: "org-1" };

const montar = () =>
  render(
    <MemoryRouter>
      <ConfirmProvider>
        <PromptProvider>
          <SidebarProvider>
            <AppSidebar />
          </SidebarProvider>
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  api.get.mockResolvedValue({ success: true, data: [] });
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useAuthStore.setState({
    session: { id: "u-1", username: "ana", superadmin: false },
    accessToken: "t",
  } as never);
  useMyWorkStore.setState({ scope: ACOTADO });
});
afterEach(cleanup);

describe("la fila de «My work» del menú", () => {
  /** El mutante que mata: `onClick` volviendo a ser sólo `navigate`. */
  it("quita el filtro de lista", () => {
    montar();
    fireEvent.click(screen.getByText("My work"));
    expect(useMyWorkStore.getState().scope).toBeNull();
  });

  /**
   * Y sólo ésa.
   *
   * El manejador es uno para las nueve filas, así que quitar el filtro sin
   * mirar cuál se pulsó lo tiraría al ir a Documentos o a Canales — y volver a
   * «mi trabajo» habría perdido por el camino lo que estabas mirando.
   */
  it("y ninguna otra fila lo toca", () => {
    montar();
    fireEvent.click(screen.getByText("All docs"));
    expect(useMyWorkStore.getState().scope).toMatchObject(ACOTADO);
  });
});
