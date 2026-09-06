import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * El medidor mantiene abierto un micrófono, y por eso importa cuándo calla.
 *
 * El lado de Rust no tiene comando de «parar»: la prueba se cierra sola cuando
 * nadie vuelve a preguntar. Eso es deliberado —un parar que hay que acordarse
 * de llamar es un micrófono abierto olvidado, y eso es una luz encendida en la
 * cámara de alguien— pero traslada la responsabilidad aquí: si este componente
 * sigue preguntando después de desmontarse, el micrófono no se cierra nunca.
 */

const invoke = vi.fn(async () => ({
  enLlamada: false,
  picoMilesimas: 0,
  formatoEntrada: null,
  error: null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => invoke() }));

const MicLevel = (await import("@/components/voice/MicLevel")).default;

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("el medidor de micrófono", () => {
  it("pregunta mientras está en pantalla", async () => {
    render(<MicLevel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(invoke.mock.calls.length).toBeGreaterThan(2);
  });

  // Lo que apaga el micrófono. Sin esto se quedaría abierto indefinidamente.
  it("deja de preguntar al desaparecer, que es lo que cierra el micrófono", async () => {
    const { unmount } = render(<MicLevel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    unmount();
    const alSalir = invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(invoke.mock.calls.length).toBe(alSalir);
  });

  /**
   * Si el motor se cae a mitad, la barra desaparece — no se queda quieta.
   *
   * Es el modo de fallo que este componente existe para evitar, del revés: una
   * barra congelada a media altura dice «entra señal» mientras el micrófono está
   * muerto. Mejor no decir nada que decir algo falso sobre el micrófono, que es
   * justo lo que costó la investigación de #41.
   */
  it("si el motor se cae después, deja de pintar en vez de congelarse", async () => {
    invoke.mockResolvedValueOnce({
      enLlamada: false,
      picoMilesimas: 700,
      formatoEntrada: null,
      error: null,
    });
    render(<MicLevel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByRole("meter")).toBeTruthy();

    invoke.mockRejectedValue(new Error("el motor murió"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByRole("meter")).toBeNull();
  });

  // Un build sin motor de voz no puede tumbar el panel de dispositivos: la
  // lista de micrófonos sigue sirviendo aunque el medidor no.
  it("si el motor no responde, no pinta nada y no revienta", async () => {
    invoke.mockRejectedValue(new Error("sin motor"));
    render(<MicLevel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.queryByRole("meter")).toBeNull();
  });
});
