import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

/**
 * The account menu, and the two things it exists to fix.
 *
 * Everything about you used to be six rows stacked under the navigation, which
 * put "change my password" at the same level as "Notes" and left logging out —
 * the last of them — as the easiest thing in the sidebar to hit by accident.
 * So: it starts closed, and log out is only reachable once you have opened it
 * on purpose.
 */

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const logout = vi.fn();
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ logout }) }));
vi.mock("@/hooks/use-app-version", () => ({ useAppVersion: () => "1.6.29" }));

const { MemoryRouter } = await import("react-router-dom");
const { default: AccountMenu } = await import("@/components/AccountMenu");
const { useAuthStore } = await import("@/store/auth.store");
const { useConnectionStore } = await import("@/store/connection.store");
const { useLocaleStore } = await import("@/store/locale.store");

beforeEach(() => {
  useAuthStore.setState({
    session: { id: "u-1", username: "romanshk", email: "ro@nuke-ai.com", superadmin: true },
  } as never);
  useConnectionStore.setState({ stream: "open" } as never);
});
afterEach(() => {
  logout.mockReset();
  cleanup();
});

const montar = () =>
  render(
    <MemoryRouter>
      <AccountMenu onChangePassword={() => {}} onConnectMcp={() => {}} onNotificationPrefs={() => {}} />
    </MemoryRouter>,
  );

const abrir = () => fireEvent.click(screen.getByRole("button", { expanded: false }));

describe("el menú de cuenta", () => {
  it("empieza cerrado, con cerrar sesión fuera de alcance", () => {
    montar();
    expect(screen.queryByText("Log out")).toBeNull();
    expect(screen.getByText("romanshk")).toBeTruthy();
  });

  it("abierto enseña quién eres, con el email que distingue dos cuentas", () => {
    montar();
    abrir();
    expect(screen.getByText("ro@nuke-ai.com")).toBeTruthy();
    expect(screen.getByText("Log out")).toBeTruthy();
  });

  /**
   * La fila de un ajuste, no el menú entero.
   *
   * Tema e idioma ofrecen los dos un «Auto», así que buscarlo suelto encuentra
   * los dos y la prueba deja de decir de cuál habla.
   */
  const fila = (etiqueta: string) => within(screen.getByText(etiqueta).closest("div")!);

  it("ofrece los tres temas a la vez, no un botón que cicla", () => {
    montar();
    abrir();
    // Con un botón que cicla no se puede distinguir «auto, ahora oscuro» de
    // «oscuro», y son respuestas distintas.
    for (const t of ["Auto", "Light", "Dark"]) expect(fila("Theme").getByText(t)).toBeTruthy();
  });

  // El idioma se elige igual, y por lo mismo.
  it("y los tres idiomas, con cada nombre en su idioma", () => {
    montar();
    abrir();
    // «English» y «Español», no «Inglés» y «Spanish»: quien busca el suyo en una
    // lista lo busca escrito como él lo escribe.
    for (const l of ["Auto", "English", "Español"]) {
      expect(fila("Language").getByText(l)).toBeTruthy();
    }
  });

  it("elegir un idioma lo guarda", () => {
    montar();
    abrir();
    fireEvent.click(fila("Language").getByText("Español"));
    expect(useLocaleStore.getState().preference).toBe("es");
    expect(useLocaleStore.getState().resolved).toBe("es");
  });

  it("el punto mira el stream, no la última petición", () => {
    useConnectionStore.setState({ stream: "closed" } as never);
    const { container } = montar();
    // Una consola que dejó de recibir eventos parece sana hasta que algo
    // debería haberse movido y no se movió.
    expect(container.querySelector(".bg-destructive")).toBeTruthy();
    cleanup();
    useConnectionStore.setState({ stream: "open" } as never);
    const otra = montar();
    expect(otra.container.querySelector(".bg-success")).toBeTruthy();
  });
});
