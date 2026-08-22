import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * La barra de la llamada tiene que decir tres cosas de un vistazo: quién está,
 * quién habla, y si estás solo.
 *
 * La primera versión enseñaba un número y dos iconos. «1» no dice si te oyen,
 * ni a quién oyes tú — y una llamada en la que nadie te escucha se veía igual
 * que una que iba bien.
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
  spaceId: "esp-1",
  estado: "dentro",
  gente: [] as { identity: string; name: string }[],
  hablando: [] as string[],
  yo: "u-ana",
  mic: true,
  error: null,
  ocupacion: {},
  entrar: vi.fn(),
  salir: vi.fn(),
  alternarMic: vi.fn(),
};

beforeEach(() => {
  estado.current = { ...base };
});
afterEach(cleanup);

describe("la barra de la llamada", () => {
  it("dice quién está por su nombre, no un número", () => {
    estado.current = { ...base, gente: [{ identity: "u-bea", name: "bea" }] };
    render(<BarraDePrueba spaceId="esp-1" />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("bea")).toBeTruthy();
  });

  it("avisa cuando estás solo, en vez de dejarte deducirlo de un «1»", () => {
    render(<BarraDePrueba spaceId="esp-1" />);
    expect(screen.getByText(/nadie más aún/)).toBeTruthy();
  });

  it("y deja de avisarlo en cuanto entra alguien", () => {
    estado.current = { ...base, gente: [{ identity: "u-bea", name: "bea" }] };
    render(<BarraDePrueba spaceId="esp-1" />);
    expect(screen.queryByText(/nadie más aún/)).toBeNull();
  });

  it("marca a quien habla y sólo a quien habla", () => {
    estado.current = {
      ...base,
      gente: [{ identity: "u-bea", name: "bea" }, { identity: "u-caro", name: "caro" }],
      hablando: ["u-bea"],
    };
    render(<BarraDePrueba spaceId="esp-1" />);
    // El color es lo que convierte la lista en «quién está diciendo esto».
    expect(screen.getByText("bea").className).toContain("text-success");
    expect(screen.getByText("caro").className).not.toContain("text-success");
  });

  it("el botón dice qué va a hacer, no en qué estado está", () => {
    render(<BarraDePrueba spaceId="esp-1" />);
    // Con el micro abierto, el botón ofrece silenciarlo. Al revés se lee como
    // «estás silenciado» y la gente pulsa justo lo contrario de lo que quiere.
    expect(screen.getByTitle("Mute your microphone")).toBeTruthy();
  });
});
