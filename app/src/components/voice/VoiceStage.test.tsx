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
  mudos: {} as Record<string, boolean>,
  latencia: null as number | null,
  video: {} as Record<string, boolean>,
  cam: false,
  hablandoYo: false,
  pantalla: null as string | null,
  compartiendo: false,
};

beforeEach(() => {
  estado.current = {
    ...base,
    salir: vi.fn(),
    alternarMic: vi.fn(),
    alternarSordera: vi.fn(),
    alternarCam: vi.fn(),
    alternarCompartir: vi.fn(),
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

  it("tacha el micrófono de quien el motor dice que está mudo", () => {
    estado.current = {
      ...estado.current,
      gente: [{ identity: "u-bea", name: "bea" }, { identity: "u-caro", name: "caro" }],
      mudos: { "u-bea": true, "u-caro": false },
    };
    render(<Escenario spaceName="general" />);
    expect(screen.getByTitle("bea is muted")).toBeTruthy();
    expect(screen.queryByTitle("caro is muted")).toBeNull();
  });

  it("y del que no se sabe nada, no dice que esté mudo", () => {
    estado.current = { ...estado.current, gente: [{ identity: "u-bea", name: "bea" }], mudos: {} };
    render(<Escenario spaceName="general" />);
    // Pintar mudo a quien no ha reportado su pista es peor que no pintar nada:
    // te callas creyendo que el otro no te oye.
    expect(screen.queryByTitle("bea is muted")).toBeNull();
  });

  it("tu propio micrófono sale de lo que pulsaste, no del servidor", () => {
    estado.current = { ...estado.current, mic: false, mudos: {} };
    render(<Escenario spaceName="general" />);
    expect(screen.getByTitle("You is muted")).toBeTruthy();
  });

  it("enseña la latencia sólo cuando se sabe", () => {
    estado.current = { ...estado.current, gente: [{ identity: "u-bea", name: "bea" }] };
    const { rerender } = render(<Escenario spaceName="general" />);
    // Mientras se establece la conexión no hay par ICE nominado; un «0 ms» ahí
    // se lee como una llamada perfecta justo cuando todavía no lo es.
    expect(screen.getByText(/2 in voice/).textContent).not.toContain("ms");
    estado.current = { ...estado.current, latencia: 38 };
    rerender(<Escenario spaceName="general" />);
    expect(screen.getByText(/2 in voice/).textContent).toContain("· 38 ms");
  });

  it("pone el lienzo del vídeo a quien publica cámara", () => {
    estado.current = {
      ...estado.current,
      gente: [{ identity: "u-bea", name: "bea" }, { identity: "u-caro", name: "caro" }],
      video: { "u-bea": true },
    };
    const { container } = render(<Escenario spaceName="general" />);
    // Un lienzo y sólo uno: el de quien tiene cámara encendida.
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("te pintas a ti mismo cuando enciendes tu cámara", () => {
    // El motor no se suscribe a sus propias pistas —el SFU no te devuelve lo
    // que mandas— así que esto sale de `cam`, no del mapa de los demás. Sin
    // ello, encender la cámara solo en la sala no enseñaba nada y parecía
    // rota: fue lo primero que se reportó de la v1.6.41.
    estado.current = { ...estado.current, cam: true, video: {} };
    const { container } = render(<Escenario spaceName="general" />);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("y tu cara va en espejo, la de los demás no", () => {
    estado.current = {
      ...estado.current,
      cam: true,
      gente: [{ identity: "u-bea", name: "bea" }],
      video: { "u-bea": true },
    };
    const { container } = render(<Escenario spaceName="general" />);
    const lienzos = [...container.querySelectorAll("canvas")];
    expect(lienzos).toHaveLength(2);
    // Levantar la mano derecha tiene que mover el lado derecho de tu imagen.
    // Sin voltear te ves como te ven los demás, y todo sale al revés.
    expect(lienzos.filter((c) => c.className.includes("-scale-x-100"))).toHaveLength(1);
  });

  it("con la cámara apagada no hay lienzo propio", () => {
    estado.current = { ...estado.current, cam: false, video: { "u-ana": true } };
    const { container } = render(<Escenario spaceName="general" />);
    // Y no lo enciende que el mapa de los demás mencione tu id: el tuyo sale
    // de lo que tú pulsaste.
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("tu propia pantalla compartida también ocupa el escenario", () => {
    estado.current = { ...estado.current, compartiendo: true, pantalla: null };
    render(<Escenario spaceName="general" />);
    // Sin esto, compartir con nadie más en la sala no enseñaba nada y no había
    // forma de saber si funcionaba.
    expect(screen.getByText("You are sharing")).toBeTruthy();
  });

  it("el botón de la cámara ya hace algo, y dice qué", () => {
    render(<Escenario spaceName="general" />);
    fireEvent.click(screen.getByLabelText("Turn your camera on"));
    expect(estado.current.alternarCam).toHaveBeenCalled();
  });

  it("tu recuadro se enciende con tu micrófono, no con la lista del servidor", () => {
    // En la v1.6.38 no se encendía nunca: la lista la decide el SFU, tarda su
    // medio segundo y puede no incluirte. Tu propio recuadro no puede depender
    // de que un servidor opine sobre lo que pasa en tu mesa.
    estado.current = { ...estado.current, hablandoYo: true, hablando: [] };
    render(<Escenario spaceName="general" />);
    expect(screen.getByText("You").closest("div")!.className).toContain("border-success");
  });

  it("y no se enciende porque el servidor te nombre a ti", () => {
    estado.current = { ...estado.current, hablandoYo: false, hablando: ["u-ana"] };
    render(<Escenario spaceName="general" />);
    expect(screen.getByText("You").closest("div")!.className).not.toContain("border-success");
  });

  it("no hay botones que no hagan nada", () => {
    render(<Escenario spaceName="general" />);
    // Un botón deshabilitado se lee como «existe y está apagado», no como «no
    // existe». Fue lo primero que se reportó de la v1.6.38, y la regla se
    // queda aunque ya no falte ninguno.
    expect(screen.queryAllByRole("button").filter((b) => (b as HTMLButtonElement).disabled))
      .toHaveLength(0);
  });

  it("compartir pantalla ya se puede pedir", () => {
    render(<Escenario spaceName="general" />);
    fireEvent.click(screen.getByLabelText("Share your screen"));
    expect(estado.current.alternarCompartir).toHaveBeenCalled();
  });

  it("una pantalla compartida ocupa el sitio y las caras se van al lado", () => {
    estado.current = {
      ...estado.current,
      gente: [{ identity: "u-bea", name: "bea" }],
      pantalla: "u-bea",
    };
    const { container } = render(<Escenario spaceName="general" />);
    expect(screen.getByText("bea is sharing")).toBeTruthy();
    // Dos lienzos serían la pantalla y una cámara; aquí sólo hay pantalla.
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    // Y los mosaicos pasan a compactos: la rejilla de dos columnas dejaría la
    // pantalla del tamaño de una cara, que es no compartirla.
    expect(container.querySelector(".h-30")).toBeTruthy();
  });

  it("compartiendo tú, se puede parar desde la propia pantalla", () => {
    estado.current = { ...estado.current, pantalla: "u-ana", compartiendo: true };
    render(<Escenario spaceName="general" />);
    // Sin esto habría que bajar a la barra de mandos para parar algo que estás
    // mirando — y el diseño lo pide justo por eso.
    fireEvent.click(screen.getByText("Stop sharing"));
    expect(estado.current.alternarCompartir).toHaveBeenCalled();
  });

  it("y los ajustes sí están, porque ya sirven", () => {
    render(<Escenario spaceName="general" />);
    const boton = screen.getByLabelText("Audio and video settings");
    expect((boton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(boton);
    // Se abre el panel. Sin esto, «no está deshabilitado» no dice gran cosa.
    expect(screen.getByText(/Looking for devices|Microphone/)).toBeTruthy();
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
