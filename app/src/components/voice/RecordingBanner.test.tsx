import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import RecordingBanner from "@/components/voice/RecordingBanner";
import { useVoice } from "@/store/voice.store";

afterEach(cleanup);

const salir = vi.fn();

beforeEach(() => {
  salir.mockClear();
  useVoice.setState({ grabacion: null, salir });
});

function grabando(id = "rec-1") {
  act(() => {
    useVoice.setState({ grabacion: { id, by: "u-ana", since: "" } });
  });
}

describe("el aviso al que entra tarde", () => {
  /**
   * Quien entra a una llamada que ya se graba **no ha leído nada**.
   *
   * El consentimiento de quien pulsó el botón no es el suyo, y el chip de la
   * esquina es fácil de no mirar cuando lo que haces al entrar es hablar.
   */
  it("aparece cuando hay grabación", () => {
    render(<RecordingBanner />);
    expect(screen.queryByRole("status")).toBeNull();
    grabando();
    expect(screen.getByRole("status").textContent).toContain("being recorded");
  });

  /**
   * **No bloquea, y salirse es una salida de verdad.**
   *
   * El acuerdo es «aviso + quedarse», no «acepta para poder hablar». Si la
   * única opción fuera «entendido», el aviso sería un trámite.
   */
  it("ofrece irse, y colgar de verdad", () => {
    render(<RecordingBanner />);
    grabando();
    act(() => screen.getByText("Leave the call").click());
    expect(salir).toHaveBeenCalled();
  });

  it("y se puede dar por leído", () => {
    render(<RecordingBanner />);
    grabando();
    act(() => screen.getByText("Got it").click());
    expect(screen.queryByRole("status")).toBeNull();
  });

  /**
   * Una grabación nueva vuelve a avisar; la misma, no.
   *
   * Sin el id, «entendido» valdría para siempre: alguien para, vuelve a
   * empezar media hora después, y nadie se entera. Con un booleano en vez de un
   * id, ése es exactamente el fallo.
   */
  it("parar y volver a empezar es otra grabación, y se avisa otra vez", () => {
    render(<RecordingBanner />);
    grabando("rec-1");
    act(() => screen.getByText("Got it").click());
    expect(screen.queryByRole("status")).toBeNull();

    // La misma no vuelve a molestar.
    act(() => {
      useVoice.setState({ grabacion: { id: "rec-1", by: "u-ana", since: "" } });
    });
    expect(screen.queryByRole("status")).toBeNull();

    // Otra, sí.
    grabando("rec-2");
    expect(screen.getByRole("status")).toBeTruthy();
  });

  /** Y al parar desaparece solo. */
  it("sin grabación no hay aviso", () => {
    render(<RecordingBanner />);
    grabando();
    act(() => {
      useVoice.setState({ grabacion: null });
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
