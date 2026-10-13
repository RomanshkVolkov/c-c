import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quién anda por la voz se pregunta **una** vez cada quince segundos, la miren
 * cuantos la miren. El panel y la pantalla de Canales la vigilan a la vez, y
 * con un intervalo cada uno eran dos preguntas por periodo. Mutantes: un
 * intervalo por suscriptor; parar al soltar el primero; no reiniciar al
 * cambiar de org.
 */

const ask = vi.fn(async (orgId?: string | null) => {
  void orgId;
});
vi.mock("@/store/voice.store", () => ({
  useVoice: { getState: () => ({ refrescarOcupacion: ask }) },
}));

const { watchOccupancy } = await import("@/store/voice-occupancy");

const released: (() => void)[] = [];
const watch = (org: string) => {
  const stop = watchOccupancy(org);
  released.push(stop);
  return stop;
};

beforeEach(() => {
  vi.useFakeTimers();
  ask.mockClear();
});
afterEach(() => {
  released.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

describe("la ocupación de la voz", () => {
  it("dos que miran, una pregunta al empezar y una por periodo", () => {
    watch("org-1");
    watch("org-1");
    expect(ask).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(ask).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(15_000);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("soltar uno no la para; soltar los dos sí", () => {
    const a = watch("org-1");
    const b = watch("org-1");
    a();
    vi.advanceTimersByTime(15_000);
    expect(ask).toHaveBeenCalledTimes(2);
    b();
    vi.advanceTimersByTime(60_000);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("soltar dos veces el mismo no cuenta por dos", () => {
    const a = watch("org-1");
    watch("org-1");
    a();
    a();
    vi.advanceTimersByTime(15_000);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("otra org reinicia en ésa", () => {
    watch("org-1");
    watch("org-2");
    expect(ask).toHaveBeenLastCalledWith("org-2");
    vi.advanceTimersByTime(15_000);
    expect(ask).toHaveBeenLastCalledWith("org-2");
    // Una pregunta al empezar en cada org y una del periodo, no dos.
    expect(ask).toHaveBeenCalledTimes(3);
  });
});
