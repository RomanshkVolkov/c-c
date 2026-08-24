import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El aviso se apaga solo.
 *
 * El servidor manda hasta cuándo vale, y los dos extremos lo respetan por su
 * cuenta —igual que el timbre de una llamada—. Sin esto, una reunión a la que
 * nadie hace caso deja la tarjeta tapando la pantalla entera: quien no estaba
 * delante vuelve a un ordenador bloqueado por un aviso de hace una hora.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const { useMeetingsStore } = await import("@/store/meetings.store");

const aviso = (id: string, dentroDeMs: number) => ({
  meetingId: id,
  title: "Daily",
  wallTime: "09:00",
  timezone: "UTC",
  firesAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + dentroDeMs).toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
  useMeetingsStore.setState({ entrante: null });
});
afterEach(() => vi.useRealTimers());

describe("el aviso de una reunión", () => {
  it("aparece al sonar", () => {
    useMeetingsStore.getState().alSonar(aviso("m-1", 60_000));
    expect(useMeetingsStore.getState().entrante?.meetingId).toBe("m-1");
  });

  it("se apaga solo cuando caduca", () => {
    useMeetingsStore.getState().alSonar(aviso("m-1", 60_000));
    vi.advanceTimersByTime(60_001);
    expect(useMeetingsStore.getState().entrante).toBeNull();
  });

  it("y no antes", () => {
    useMeetingsStore.getState().alSonar(aviso("m-1", 60_000));
    vi.advanceTimersByTime(59_000);
    expect(useMeetingsStore.getState().entrante?.meetingId).toBe("m-1");
  });

  // Dos reuniones a la misma hora: la segunda tapa a la primera, y el reloj de
  // la primera no puede apagar la que está viéndose ahora.
  it("el reloj de una vieja no apaga la nueva", () => {
    useMeetingsStore.getState().alSonar(aviso("m-1", 10_000));
    useMeetingsStore.getState().alSonar(aviso("m-2", 60_000));
    vi.advanceTimersByTime(11_000);
    expect(useMeetingsStore.getState().entrante?.meetingId).toBe("m-2");
  });

  it("descartarla la quita en el momento", () => {
    useMeetingsStore.getState().alSonar(aviso("m-1", 60_000));
    useMeetingsStore.getState().descartar();
    expect(useMeetingsStore.getState().entrante).toBeNull();
  });

  // Descartada a mano, el reloj que quedaba no puede resucitar nada ni apagar
  // una reunión posterior.
  it("y descartarla apaga su reloj", () => {
    useMeetingsStore.getState().alSonar(aviso("m-1", 10_000));
    useMeetingsStore.getState().descartar();
    useMeetingsStore.getState().alSonar(aviso("m-2", 60_000));
    vi.advanceTimersByTime(11_000);
    expect(useMeetingsStore.getState().entrante?.meetingId).toBe("m-2");
  });

  // Un aviso que llega ya caducado —el reloj de la máquina va adelantado, o la
  // trama llegó tarde— no puede quedarse fijo para siempre.
  it("uno que llega caducado se va en cuanto puede", () => {
    useMeetingsStore.getState().alSonar(aviso("m-1", -5_000));
    vi.advanceTimersByTime(1);
    expect(useMeetingsStore.getState().entrante).toBeNull();
  });
});
