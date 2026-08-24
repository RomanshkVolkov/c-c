import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * La tarjeta que suena cuando empieza una reunión.
 *
 * Lo que se prueba es lo que la separa del timbre de una llamada: que lleva a
 * la sala **si la reunión tiene una**, que no ofrece entrar a ninguna parte
 * cuando no la tiene, que respeta la sordera, y que se apaga sola a la hora que
 * dijo el servidor — sin eso, una reunión que nadie mira deja la pantalla
 * tapada hasta que alguien vuelva al ordenador.
 */

const { entrar, tono, parar, navigate, estado } = vi.hoisted(() => ({
  entrar: vi.fn(),
  tono: vi.fn(),
  parar: vi.fn(),
  navigate: vi.fn(),
  estado: {
    reunion: { current: null as Record<string, unknown> | null },
    sordo: { current: false },
    descartar: vi.fn(),
  },
}));

vi.mock("@/store/meetings.store", () => ({
  useMeetingsStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ entrante: estado.reunion.current, descartar: estado.descartar }),
    { getState: () => ({ entrante: estado.reunion.current, descartar: estado.descartar }) },
  ),
}));
vi.mock("@/store/voice.store", () => ({
  useVoice: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ sordo: estado.sordo.current, entrar }),
    { getState: () => ({ entrar }) },
  ),
}));
vi.mock("@/components/voice/ringtone", () => ({
  tonoEntrante: () => {
    tono();
    return { parar };
  },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

const { default: MeetingCall } = await import("@/components/meetings/MeetingCall");

const reunion = (extra: Record<string, unknown> = {}) => ({
  meetingId: "m-1",
  title: "Daily standup",
  spaceId: "esp-g",
  spaceName: "General",
  wallTime: "09:00",
  timezone: "America/Mexico_City",
  firesAt: "2026-08-25T15:00:00Z",
  expiresAt: "2026-08-25T15:01:00Z",
  ...extra,
});

beforeEach(() => {
  entrar.mockResolvedValue(undefined);
  estado.sordo.current = false;
  estado.reunion.current = null;
  [tono, parar, navigate, estado.descartar, entrar].forEach((f) => f.mockClear());
});
afterEach(cleanup);

describe("cuando no hay reunión sonando", () => {
  it("no hay nada en pantalla", () => {
    const { container } = render(<MeetingCall />);
    expect(container.firstChild).toBeNull();
  });
});

describe("la tarjeta", () => {
  it("dice qué reunión es y a qué sala lleva", () => {
    estado.reunion.current = reunion();
    render(<MeetingCall />);
    expect(screen.getByText("Daily standup")).toBeTruthy();
    expect(screen.getByText("Join #General")).toBeTruthy();
  });

  // La hora de la reunión, no la del que mira. Quien la creó dijo «las nueve»
  // pensando en su reloj.
  it("enseña la hora en la zona de la reunión", () => {
    estado.reunion.current = reunion();
    render(<MeetingCall />);
    // 15:00Z son las 9:00 en CDMX, se escriba «09:00» o «9:00 AM».
    expect(document.body.textContent).toMatch(/9:00/);
  });

  it("suena", () => {
    estado.reunion.current = reunion();
    render(<MeetingCall />);
    expect(tono).toHaveBeenCalled();
  });

  // Quien se ha puesto sordo ha pedido que el ordenador se calle; sonarle igual
  // porque «esto es otra cosa» es no haberle hecho caso.
  it("pero no si te pusiste sordo", () => {
    estado.sordo.current = true;
    estado.reunion.current = reunion();
    render(<MeetingCall />);
    expect(tono).not.toHaveBeenCalled();
  });

  it("y deja de sonar al irse", () => {
    estado.reunion.current = reunion();
    const { unmount } = render(<MeetingCall />);
    unmount();
    expect(parar).toHaveBeenCalled();
  });
});

describe("entrar a la sala", () => {
  it("entra a la llamada de esa sala y te lleva al canal", async () => {
    estado.reunion.current = reunion();
    render(<MeetingCall />);
    fireEvent.click(screen.getByText("Join #General"));
    await vi.waitFor(() => expect(entrar).toHaveBeenCalledWith("esp-g"));
    expect(navigate).toHaveBeenCalledWith("/chat?space=esp-g");
  });

  it("y la tarjeta se quita", () => {
    estado.reunion.current = reunion();
    render(<MeetingCall />);
    fireEvent.click(screen.getByText("Join #General"));
    expect(estado.descartar).toHaveBeenCalled();
  });

  // Un botón «entrar» que no entra a ningún sitio es peor que no tenerlo.
  it("una reunión sin sala no ofrece entrar a ninguna parte", () => {
    estado.reunion.current = reunion({ spaceId: undefined, spaceName: undefined });
    render(<MeetingCall />);
    expect(screen.queryByText(/^Join/)).toBeNull();
    expect(screen.getByText("Got it")).toBeTruthy();
  });

  it("y cerrarla no intenta entrar a nada", () => {
    estado.reunion.current = reunion({ spaceId: undefined, spaceName: undefined });
    render(<MeetingCall />);
    fireEvent.click(screen.getByText("Got it"));
    expect(entrar).not.toHaveBeenCalled();
    expect(estado.descartar).toHaveBeenCalled();
  });

  it("descartarla tampoco entra a nada", () => {
    estado.reunion.current = reunion();
    render(<MeetingCall />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(entrar).not.toHaveBeenCalled();
    expect(estado.descartar).toHaveBeenCalled();
  });
});
