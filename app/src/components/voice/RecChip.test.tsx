import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import RecChip from "@/components/voice/RecChip";
import RecordingConsentDialog from "@/components/voice/RecordingConsentDialog";

// Sin esto, el segundo `render` convive con el primero y `getByRole` encuentra
// dos chips. No hay limpieza automática en esta configuración.
afterEach(cleanup);

describe("el chip de grabación", () => {
  /**
   * No puede ser sólo un punto rojo.
   *
   * Dos razones que se suman: quien no distingue el rojo no ve nada, y un rojo
   * sobre oscuro se lee igual como «activo» que como «error». La palabra REC y
   * el nombre son lo que lo hace legible sin depender del color.
   */
  it("dice REC y de quién, no sólo un color", () => {
    render(<RecChip by="Ana" />);
    const chip = screen.getByRole("status");
    expect(chip.textContent).toContain("REC");
    expect(chip.textContent).toContain("Ana");
  });

  /** Sin nombre todavía, el aviso sigue estando: lo que importa es que se sepa. */
  it("sin nombre sigue avisando", () => {
    render(<RecChip />);
    expect(screen.getByRole("status").textContent).toContain("REC");
  });

  /**
   * Un lector de pantalla tiene que anunciarlo **al aparecer**.
   *
   * Sin `role="status"`, quien no ve la pantalla se entera de que se le está
   * grabando sólo si se le ocurre ir a buscarlo con el tabulador.
   */
  it("se anuncia solo", () => {
    render(<RecChip by="Ana" />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  /**
   * Y el parpadeo se apaga si alguien lo ha pedido.
   *
   * `motion-safe:` y no `animate-pulse` a secas: algo latiendo en una esquina
   * durante una reunión de una hora no es un detalle para quien le afecta.
   */
  it("el parpadeo respeta «menos movimiento»", () => {
    const { container } = render(<RecChip by="Ana" />);
    const punto = container.querySelector("[aria-hidden]");
    expect(punto?.className).toContain("motion-safe:animate-pulse");
    // Y **no** el `animate-pulse` pelado, que late pase lo que pase.
    expect(punto?.className.split(/\s+/)).not.toContain("animate-pulse");
  });
});

describe("el diálogo de consentimiento", () => {
  /**
   * **Dice que las cámaras no se graban.**
   *
   * Es la decisión de producto, y es lo que alguien necesita saber antes de
   * decir que sí. El mutante que mata: quitar la frase del catálogo o del
   * diálogo — y sin esta prueba se caería sin que nada se rompiera.
   */
  it("dice qué se graba y qué no", () => {
    render(<RecordingConsentDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const texto = document.body.textContent ?? "";
    expect(texto.toLowerCase()).toContain("camera");
    // Y lo que sí entra.
    expect(texto.toLowerCase()).toContain("screen");
  });

  /** Y quién lo va a poder ver, que es la otra mitad de la decisión. */
  it("dice dónde queda y quién lo verá", () => {
    render(<RecordingConsentDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const texto = (document.body.textContent ?? "").toLowerCase();
    expect(texto).toContain("channel");
    expect(texto).toContain("server");
  });

  it("mientras está en vuelo no se puede pulsar dos veces", () => {
    render(<RecordingConsentDialog open enVuelo onOpenChange={() => {}} onConfirm={() => {}} />);
    for (const b of screen.getAllByRole("button")) {
      if (b.textContent?.includes("Start recording")) expect(b).toHaveProperty("disabled", true);
    }
  });
});
