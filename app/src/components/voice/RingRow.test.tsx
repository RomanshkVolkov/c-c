import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * La fila de «estoy llamando».
 *
 * Su trabajo difícil es el final: cuando nadie contesta, la fila **no
 * desaparece**. Una que se esfuma sola no distingue «no contestó» de «el botón
 * nunca hizo nada», y esa duda acaba en un segundo timbre a alguien que ya
 * decidió no cogerlo.
 */

const { estado } = vi.hoisted(() => ({ estado: { current: {} as Record<string, unknown> } }));

vi.mock("@/store/voice.store", () => ({
  useVoice: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) =>
      sel ? sel(estado.current) : estado.current,
    { getState: () => estado.current },
  ),
}));

const { default: Fila } = await import("./RingRow");

beforeEach(() => {
  estado.current = {
    llamando: { identity: "u-bea", name: "Bea Ruiz", desde: Date.now(), sinRespuesta: false },
    sordo: false,
    cancelarTimbre: vi.fn(),
    timbrar: vi.fn(() => Promise.resolve()),
  };
});
afterEach(cleanup);

describe("la fila del timbre saliente", () => {
  it("no ocupa sitio si no estás llamando a nadie", () => {
    estado.current = { ...estado.current, llamando: null };
    const { container } = render(<Fila />);
    expect(container.textContent).toBe("");
  });

  it("mientras suena, dice a quién y ofrece cancelar", () => {
    render(<Fila />);
    expect(screen.getByText("Ringing Bea Ruiz")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    expect(screen.queryByText("Ring again")).toBeNull();
  });

  it("cuando se rinde lo dice, y sigue ahí", () => {
    estado.current = {
      ...estado.current,
      llamando: { identity: "u-bea", name: "Bea Ruiz", desde: Date.now(), sinRespuesta: true },
    };
    render(<Fila />);
    expect(screen.getByText("did not answer")).toBeTruthy();
    expect(screen.getByText("Bea Ruiz")).toBeTruthy();
    // Y deja de ofrecer «cancelar» algo que ya no está sonando.
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  it("volver a llamar es a la misma persona, no a nadie", () => {
    estado.current = {
      ...estado.current,
      llamando: { identity: "u-bea", name: "Bea Ruiz", desde: Date.now(), sinRespuesta: true },
    };
    render(<Fila />);
    fireEvent.click(screen.getByText("Ring again"));
    expect(estado.current.timbrar).toHaveBeenCalledWith("u-bea", "Bea Ruiz");
  });

  it("quitar el aviso de en medio no vuelve a llamar", () => {
    estado.current = {
      ...estado.current,
      llamando: { identity: "u-bea", name: "Bea Ruiz", desde: Date.now(), sinRespuesta: true },
    };
    render(<Fila />);
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(estado.current.cancelarTimbre).toHaveBeenCalled();
    expect(estado.current.timbrar).not.toHaveBeenCalled();
  });
});
