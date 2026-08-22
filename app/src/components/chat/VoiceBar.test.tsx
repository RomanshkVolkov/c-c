import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * La puerta de la llamada, en la cabecera del canal.
 *
 * Ya no es la llamada entera —eso es `VoiceStage`—, así que aquí sólo se
 * comprueban las dos cosas que decide: si estás dentro o fuera **de este**
 * canal, y qué se ofrece en cada caso.
 */

const { estado } = vi.hoisted(() => ({ estado: { current: {} as Record<string, unknown> } }));

vi.mock("@/store/voice.store", () => ({
  useVoice: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) =>
      sel ? sel(estado.current) : estado.current,
    { getState: () => estado.current },
  ),
}));

const { default: BarraDePrueba } = await import("./VoiceBar");

const base = {
  spaceId: null as string | null,
  estado: "fuera",
  mic: true,
  error: null,
  ocupacion: {} as Record<string, { identity: string; name: string }[]>,
  entrar: vi.fn(),
  abrirEscenario: vi.fn(),
  alternarMic: vi.fn(),
};

beforeEach(() => {
  estado.current = { ...base, entrar: vi.fn(), abrirEscenario: vi.fn(), alternarMic: vi.fn() };
});
afterEach(cleanup);

describe("la puerta de la voz del canal", () => {
  it("enseña quién hay dentro antes de entrar", () => {
    estado.current = {
      ...estado.current,
      ocupacion: { "esp-1": [{ identity: "u-bea", name: "Bea Ruiz" }] },
    };
    render(<BarraDePrueba spaceId="esp-1" />);
    // El motivo para pulsar es la gente, no el botón: un canal de voz vacío no
    // se llena nunca porque nadie entra el primero.
    expect(screen.getByTitle("Bea Ruiz")).toBeTruthy();
  });

  it("estando dentro de este canal, ofrece volver a la llamada", () => {
    estado.current = { ...estado.current, spaceId: "esp-1", estado: "dentro" };
    render(<BarraDePrueba spaceId="esp-1" />);
    expect(screen.getByText("Back to call")).toBeTruthy();
    expect(screen.queryByText("Join voice")).toBeNull();
  });

  it("volver no reconecta: abre la pantalla y ya", () => {
    estado.current = { ...estado.current, spaceId: "esp-1", estado: "dentro" };
    render(<BarraDePrueba spaceId="esp-1" />);
    fireEvent.click(screen.getByText("Back to call"));
    expect(estado.current.abrirEscenario).toHaveBeenCalled();
    expect(estado.current.entrar).not.toHaveBeenCalled();
  });

  it("estando en OTRA sala, este canal sigue ofreciendo entrar", () => {
    estado.current = { ...estado.current, spaceId: "esp-2", estado: "dentro" };
    render(<BarraDePrueba spaceId="esp-1" />);
    // Sin esta distinción, «Back to call» aparecería en todos los canales y te
    // llevaría a una conversación que no es la que estás mirando.
    expect(screen.getByText("Join voice")).toBeTruthy();
  });

  it("el botón del micro dice qué va a hacer, no en qué estado está", () => {
    estado.current = { ...estado.current, spaceId: "esp-1", estado: "dentro" };
    render(<BarraDePrueba spaceId="esp-1" />);
    // Al revés se lee como «estás silenciado» y la gente pulsa lo contrario de
    // lo que quiere.
    expect(screen.getByTitle("Mute your microphone")).toBeTruthy();
  });
});
