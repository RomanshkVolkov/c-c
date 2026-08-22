import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * La tarjeta de llamada entrante.
 *
 * Es la única cosa de la app que se pone encima de todo lo demás, y eso hay que
 * ganárselo: una llamada caduca en veinte segundos y no admite «luego la miro».
 * Lo que se comprueba aquí es que diga las dos cosas que hacen falta para
 * decidir —quién y a qué canal— y que los dos botones hagan cosas distintas.
 */

const { estado } = vi.hoisted(() => ({ estado: { current: {} as Record<string, unknown> } }));

vi.mock("@/store/voice.store", () => ({
  useVoice: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) =>
      sel ? sel(estado.current) : estado.current,
    { getState: () => estado.current },
  ),
}));

const { default: Entrante } = await import("./IncomingCall");

const timbre = {
  ringId: "r-1",
  spaceId: "esp-9",
  spaceName: "general",
  from: { id: "u-bea", name: "Bea Ruiz" },
  expiresAt: new Date(Date.now() + 20_000).toISOString(),
};

beforeEach(() => {
  estado.current = {
    entrante: timbre,
    sordo: false,
    ocupacion: {},
    aceptarEntrante: vi.fn(),
    rechazarEntrante: vi.fn(),
  };
});
afterEach(cleanup);

describe("te están llamando", () => {
  it("no tapa nada cuando no hay llamada", () => {
    estado.current = { ...estado.current, entrante: null };
    const { container } = render(<Entrante />);
    expect(container.textContent).toBe("");
  });

  it("dice quién llama y a qué canal", () => {
    render(<Entrante />);
    expect(screen.getByText("Bea Ruiz")).toBeTruthy();
    // El canal importa tanto como el nombre: la misma persona te puede llamar
    // a la reunión de un cliente o a la de otro.
    expect(screen.getByText(/Calling you to #general/)).toBeTruthy();
  });

  it("y cuánta gente hay ya dentro, cuando se sabe", () => {
    estado.current = {
      ...estado.current,
      ocupacion: { "esp-9": [{ identity: "u-ana", name: "ana" }, { identity: "u-luis", name: "luis" }] },
    };
    render(<Entrante />);
    expect(screen.getByText(/2 in voice/)).toBeTruthy();
  });

  it("contestar y rechazar no son el mismo botón", () => {
    render(<Entrante />);
    fireEvent.click(screen.getByText("Join"));
    expect(estado.current.aceptarEntrante).toHaveBeenCalled();
    expect(estado.current.rechazarEntrante).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Decline"));
    expect(estado.current.rechazarEntrante).toHaveBeenCalled();
  });
});
