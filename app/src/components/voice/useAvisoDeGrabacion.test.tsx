import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info } }));

import { useAvisoDeGrabacion } from "@/components/voice/useAvisoDeGrabacion";
import { useVoice } from "@/store/voice.store";

afterEach(cleanup);

function Sonda({ nombre }: { nombre?: string }) {
  useAvisoDeGrabacion(nombre);
  return null;
}

beforeEach(() => {
  info.mockClear();
  useVoice.setState({ grabacion: null, escenario: false });
});

function grabando(id = "rec-1") {
  act(() => {
    useVoice.setState({ grabacion: { id, by: "u-ana", since: "" } });
  });
}

describe("el aviso de que alguien empezó a grabar", () => {
  /**
   * Para quien tiene la llamada minimizada, que es quien no ve ni la franja ni
   * el chip de la cabecera — y sigue hablando sin saberlo.
   */
  it("avisa con el nombre de quien graba", () => {
    render(<Sonda nombre="Ana" />);
    grabando();
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0][0])).toContain("Ana");
  });

  /**
   * **Con el escenario abierto se calla.**
   *
   * Allí ya hay una franja que lo dice. El mismo hecho anunciado dos veces se
   * lee como dos grabaciones.
   */
  it("no dice nada si el escenario está abierto", () => {
    useVoice.setState({ escenario: true });
    render(<Sonda nombre="Ana" />);
    grabando();
    expect(info).not.toHaveBeenCalled();
  });

  /**
   * Y no vuelve a decirlo al minimizar: quien ya lo leyó en la franja no
   * necesita el toast de lo mismo.
   */
  it("si ya se vio en el escenario, minimizar no lo repite", () => {
    useVoice.setState({ escenario: true });
    render(<Sonda nombre="Ana" />);
    grabando();
    act(() => {
      useVoice.setState({ escenario: false });
    });
    expect(info).not.toHaveBeenCalled();
  });

  /** Una vez por grabación: el reloj toca muchas veces y el aviso es uno. */
  it("no se repite con la misma grabación", () => {
    render(<Sonda nombre="Ana" />);
    grabando("rec-1");
    act(() => {
      useVoice.setState({ grabacion: { id: "rec-1", by: "u-ana", since: "x" } });
    });
    expect(info).toHaveBeenCalledOnce();
  });

  /** Pero parar y volver a empezar sí es otra, y se anuncia. */
  it("una grabación nueva se anuncia otra vez", () => {
    render(<Sonda nombre="Ana" />);
    grabando("rec-1");
    grabando("rec-2");
    expect(info).toHaveBeenCalledTimes(2);
  });

  /**
   * Sin nombre todavía, se avisa igual **y con una frase entera**.
   *
   * El nombre puede faltar: quien graba se fue de la llamada, o la lista de
   * participantes todavía no ha llegado. Interpolar un hueco vacío en «{{name}}
   * ha empezado a grabar» deja un aviso que empieza en blanco y parece roto;
   * hay una frase distinta para ese caso.
   */
  it("sin saber quién, avisa con una frase que se sostiene sola", () => {
    render(<Sonda />);
    grabando();
    expect(info).toHaveBeenCalledOnce();
    const dicho = String(info.mock.calls[0][0]);
    expect(dicho).toBe("This call is being recorded");
    expect(dicho).not.toMatch(/^\s/);
  });
});
