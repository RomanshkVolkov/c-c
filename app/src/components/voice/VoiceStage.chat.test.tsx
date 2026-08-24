import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

/**
 * El chat de la sala, y las caras encima de la pantalla compartida.
 *
 * Dos cosas que se pedían al usarlo: poder escribir sin salir de la llamada, y
 * que la columna de participantes deje de robarle ancho a lo que se comparte.
 *
 * Lo que se prueba es la decisión, no el pintado: que el chat sea **el hilo del
 * canal** y no uno propio, y que las caras se aparten solas al compartir y
 * vuelvan al terminar — con la regla de siempre, que si las abres tú a mano no
 * se te vuelvan a cerrar.
 */

const { estado, post, fetchChat } = vi.hoisted(() => ({
  estado: { current: {} as Record<string, unknown>, chat: {} as Record<string, unknown> },
  post: vi.fn(),
  fetchChat: vi.fn(),
}));

vi.mock("@/store/voice.store", () => ({
  useVoice: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) => (sel ? sel(estado.current) : estado.current),
    { getState: () => estado.current },
  ),
}));
vi.mock("@/store/chat.store", () => ({
  useChatStore: Object.assign(
    (sel?: (s: Record<string, unknown>) => unknown) => (sel ? sel(estado.chat) : estado.chat),
    { getState: () => estado.chat },
  ),
}));
vi.mock("@/components/voice/VideoLienzo", () => ({ default: () => null }));
vi.mock("@/components/voice/RingRow", () => ({ default: () => null }));
vi.mock("@/components/voice/InvitePicker", () => ({
  default: () => null,
  InviteButton: () => null,
}));
vi.mock("@/components/voice/DeviceSettings", () => ({ default: () => null }));

const { default: VoiceStage } = await import("./VoiceStage");

const sala = (extra: Record<string, unknown> = {}) => {
  estado.current = {
    yo: "u-yo", spaceId: "esp-1", estado: "dentro", gente: [{ identity: "u-bea", name: "Bea" }],
    mic: true, sordo: false, cam: false, mudos: {}, video: {}, hablando: [], hablandoYo: false,
    pantalla: null, compartiendo: false, latencia: 38, error: null,
    alternarMic: vi.fn(), alternarSordera: vi.fn(), alternarCam: vi.fn(),
    alternarCompartir: vi.fn(), cerrarEscenario: vi.fn(), salir: vi.fn(), limpiarError: vi.fn(),
    ...extra,
  };
  estado.chat = {
    messages: [
      {
        id: "m1", spaceId: "esp-1", authorUserId: "u-bea", authorName: "Bea",
        body: "te paso el link", createdAt: "2026-08-24T00:41:00Z", updatedAt: "",
      },
    ],
    loading: false, spaceId: "esp-1", fetch: fetchChat, post,
  };
  return render(<VoiceStage spaceName="pixel" />);
};

const abrirChat = () => fireEvent.click(screen.getByText("Chat"));

beforeEach(() => {
  post.mockResolvedValue(undefined);
  fetchChat.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("el chat de la sala", () => {
  it("está cerrado hasta que se pide", () => {
    sala();
    expect(screen.queryByText("Channel chat")).toBeNull();
    expect(screen.getByText("Chat")).toBeTruthy();
  });

  it("la etiqueta dice lo que va a hacer, no en qué estado está", () => {
    sala();
    abrirChat();
    expect(screen.getByText("Hide chat")).toBeTruthy();
    expect(screen.queryByText("Chat")).toBeNull();
  });

  // Lo que lo define: es el hilo del canal, no un chat que se evapora al
  // colgar. Se comprueba en el sitio donde se decide — a dónde va lo escrito.
  it("lo que escribes sale en el canal, no en un chat aparte", () => {
    sala();
    abrirChat();
    const caja = screen.getByPlaceholderText("Message #pixel");
    fireEvent.change(caja, { target: { value: "portentosoftware.com/muro" } });
    fireEvent.keyDown(caja, { key: "Enter" });
    expect(post).toHaveBeenCalledWith("esp-1", "portentosoftware.com/muro");
  });

  it("enseña lo que ya hay en el hilo", () => {
    sala();
    abrirChat();
    // Dentro del panel: «Bea» también es el nombre de su mosaico, y buscarla
    // suelta encontraría las dos.
    const panel = within(screen.getByText("Channel chat").closest("aside")!);
    expect(panel.getByText("te paso el link")).toBeTruthy();
    expect(panel.getByText("Bea")).toBeTruthy();
  });

  it("no manda una línea en blanco", () => {
    sala();
    abrirChat();
    const caja = screen.getByPlaceholderText("Message #pixel");
    fireEvent.change(caja, { target: { value: "   " } });
    fireEvent.keyDown(caja, { key: "Enter" });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("las caras al compartir", () => {
  /** La tira flotante existe cuando la columna se ha apartado. */
  const tira = () => screen.queryByTitle("Show participants");

  it("sin pantalla compartida, la columna se queda", () => {
    sala();
    expect(tira()).toBeNull();
    // Y las caras **se ven**, no sólo existen.
    //
    // `getByText` encuentra igual lo que está en el DOM con `display:none`, así
    // que afirmar que Bea está no dice nada sobre si se la ve. La columna se
    // esconde con la clase `hidden`; se comprueba que no la tiene encima.
    expect(screen.getByText("Bea").closest(".hidden")).toBeNull();
    expect(screen.getByText("You").closest(".hidden")).toBeNull();
  });

  it("y compartiendo, la columna sí se esconde", () => {
    sala({ compartiendo: true });
    expect(screen.getByText("Bea").closest(".hidden")).not.toBeNull();
  });

  it("al compartir se apartan solas, encima de la imagen", () => {
    sala({ compartiendo: true });
    expect(tira()).toBeTruthy();
  });

  // El aro de quien habla es lo único que hace falta de un vistazo mientras
  // alguien presenta; sin él, apartarlas sería esconder información.
  it("se sigue viendo quién está y quién habla", () => {
    sala({ compartiendo: true, hablando: ["u-bea"] });
    expect(screen.getByTitle("Bea")).toBeTruthy();
    expect(screen.getByTitle("You")).toBeTruthy();
  });

  it("pulsándolas vuelve la columna", () => {
    sala({ compartiendo: true });
    fireEvent.click(tira()!);
    expect(tira()).toBeNull();
  });

  // Pedirlas a mano vale para esa compartición, no para siempre. Sin esto,
  // haberlas mirado una vez desactivaría la función el resto de la sesión y
  // nadie relacionaría las dos cosas — es la misma regla que en el rail.
  it("a la siguiente compartición se vuelven a apartar", () => {
    const r = sala({ compartiendo: true });
    fireEvent.click(tira()!);
    expect(tira()).toBeNull();

    // Deja de compartir…
    estado.current = { ...estado.current, compartiendo: false, pantalla: null };
    r.rerender(<VoiceStage spaceName="pixel" />);
    // …y vuelve a compartir.
    estado.current = { ...estado.current, compartiendo: true };
    r.rerender(<VoiceStage spaceName="pixel" />);
    expect(tira()).toBeTruthy();
  });
});
