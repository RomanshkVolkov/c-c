import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * La sala tiene que decir tres cosas de un vistazo: quién está, quién habla, y
 * si estás solo.
 *
 * La versión anterior —una pastilla en la cabecera— enseñaba un número. «1» no
 * dice si te oyen ni a quién oyes tú, y una llamada en la que nadie te escucha
 * se veía igual que una que iba bien.
 */

const { estado } = vi.hoisted(() => ({ estado: { current: {} as Record<string, unknown> } }));

vi.mock("@/store/voice.store", () => ({
  useVoice: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) =>
      sel ? sel(estado.current) : estado.current,
    { getState: () => estado.current },
  ),
}));

const { default: Escenario } = await import("./VoiceStage");

const base = {
  estado: "dentro",
  gente: [] as { identity: string; name: string }[],
  hablando: [] as string[],
  yo: "u-ana",
  mic: true,
  sordo: false,
};

beforeEach(() => {
  estado.current = {
    ...base,
    salir: vi.fn(),
    alternarMic: vi.fn(),
    alternarSordera: vi.fn(),
    cerrarEscenario: vi.fn(),
  };
});
afterEach(cleanup);

describe("la pantalla de la sala", () => {
  it("dice quién está por su nombre, no un número", () => {
    estado.current = { ...estado.current, gente: [{ identity: "u-bea", name: "bea" }] };
    render(<Escenario spaceName="general" />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("bea")).toBeTruthy();
  });

  it("avisa cuando estás solo, en vez de dejarte deducirlo de un «1»", () => {
    render(<Escenario spaceName="general" />);
    expect(screen.getByText("nobody else yet")).toBeTruthy();
  });

  it("y en cuanto entra alguien pasa a contar cuántos sois", () => {
    estado.current = { ...estado.current, gente: [{ identity: "u-bea", name: "bea" }] };
    render(<Escenario spaceName="general" />);
    expect(screen.queryByText("nobody else yet")).toBeNull();
    expect(screen.getByText("2 in voice")).toBeTruthy();
  });

  it("el borde verde marca a quien habla, y sólo a quien habla", () => {
    estado.current = {
      ...estado.current,
      gente: [{ identity: "u-bea", name: "bea" }, { identity: "u-caro", name: "caro" }],
      hablando: ["u-bea"],
    };
    render(<Escenario spaceName="general" />);
    // El contorno es el único indicador de habla; si no sigue a `hablando`, la
    // rejilla es una lista de nombres y no una conversación.
    const mosaico = (n: string) => screen.getByText(n).closest("div")!.className;
    expect(mosaico("bea")).toContain("border-success");
    expect(mosaico("caro")).not.toContain("border-success");
  });

  it("minimizar no cuelga", () => {
    render(<Escenario spaceName="general" />);
    fireEvent.click(screen.getByTitle("Back to the channel — you stay connected"));
    expect(estado.current.cerrarEscenario).toHaveBeenCalled();
    // El error que este diseño existe para evitar: cerrar la pantalla y
    // quedarte fuera de la conversación sin haberlo pedido.
    expect(estado.current.salir).not.toHaveBeenCalled();
  });

  it("sólo «Leave» desconecta", () => {
    render(<Escenario spaceName="general" />);
    fireEvent.click(screen.getByLabelText("Leave the call"));
    expect(estado.current.salir).toHaveBeenCalled();
  });

  it("los mandos dicen su estado sin depender del color", () => {
    estado.current = { ...estado.current, mic: false, sordo: true };
    render(<Escenario spaceName="general" />);
    // Un tinte rojo no lo ve todo el mundo, y sobre negro se lee igual de
    // «activo» que de «roto». El icono y el aria-pressed sí se leen.
    expect(screen.getByLabelText("Unmute your microphone").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Undeafen").getAttribute("aria-pressed")).toBe("true");
  });
});
