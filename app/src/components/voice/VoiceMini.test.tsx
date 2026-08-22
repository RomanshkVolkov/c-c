import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * El recordatorio de que sigues conectado.
 *
 * Existe porque minimizar ya no cuelga: sin él se puede pasar la tarde en un
 * tablero con el micrófono abierto. Así que lo que se prueba es exactamente
 * eso —que aparece cuando hay llamada y no cuando no la hay— y que volver te
 * lleva al canal **de la llamada**, no al que tengas delante.
 */

const { estado, navegado } = vi.hoisted(() => ({
  estado: { current: {} as Record<string, unknown> },
  navegado: { a: null as string | null },
}));

vi.mock("@/store/voice.store", () => ({
  useVoice: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) =>
      sel ? sel(estado.current) : estado.current,
    { getState: () => estado.current },
  ),
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: { tree: { id: string; name: string }[] }) => unknown) =>
    sel({ tree: [{ id: "esp-1", name: "general" }] }),
}));
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => (a: string) => {
    navegado.a = a;
  },
}));

const { default: Mini } = await import("./VoiceMini");

const pintar = () => render(<MemoryRouter><Mini /></MemoryRouter>);

beforeEach(() => {
  navegado.a = null;
  estado.current = {
    spaceId: "esp-1",
    estado: "dentro",
    mic: true,
    abrirEscenario: vi.fn(),
    alternarMic: vi.fn(),
    salir: vi.fn(),
  };
});
afterEach(cleanup);

describe("la barra de «sigues en la llamada»", () => {
  it("no ocupa sitio cuando no hay llamada", () => {
    estado.current = { ...estado.current, spaceId: null, estado: "fuera" };
    const { container } = pintar();
    expect(container.textContent).toBe("");
  });

  it("y tampoco cuando queda el id de la sala pero ya te has salido", () => {
    // Estar conectado lo dice `estado`, no que haya un id a mano. Colgar vacía
    // las dos cosas de una vez, pero decidirlo por el id deja la barra
    // encendida el día que alguna de las dos sobreviva a la otra.
    estado.current = { ...estado.current, spaceId: "esp-1", estado: "fuera" };
    const { container } = pintar();
    expect(container.textContent).toBe("");
  });

  it("nombra el canal en el que estás", () => {
    pintar();
    expect(screen.getByText("general")).toBeTruthy();
  });

  it("volver lleva al canal de la llamada y abre la sala", () => {
    pintar();
    fireEvent.click(screen.getByTitle("Back to the call"));
    expect(estado.current.abrirEscenario).toHaveBeenCalled();
    // Con el sidebar visible desde cualquier pantalla, «volver» tiene que
    // navegar: si sólo abriera el escenario, desde Servers no pasaría nada.
    expect(navegado.a).toBe("/chat?space=esp-1");
  });

  it("trae el mute, que es lo que se pide con prisa desde fuera", () => {
    pintar();
    fireEvent.click(screen.getByText("Mute"));
    expect(estado.current.alternarMic).toHaveBeenCalled();
  });
});
