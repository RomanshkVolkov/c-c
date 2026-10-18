import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { centeredOrigin, forgetPointer, originRef, viewportOrigin } from "@/lib/motion-origin";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * Lo que se abre crece desde donde se hizo clic, como una app desde el Dock.
 */

afterEach(() => {
  cleanup();
  forgetPointer();
  vi.useRealTimers();
});

const click = (x: number, y: number) => fireEvent.pointerDown(window, { clientX: x, clientY: y });

describe("desde dónde nace", () => {
  it("sin un clic reciente, del centro", () => {
    expect(viewportOrigin()).toBe("50% 50%");
    expect(centeredOrigin()).toBe("50% 50%");
  });

  it("a toda ventana, el punto del clic tal cual", () => {
    click(120, 340);
    expect(viewportOrigin()).toBe("120px 340px");
  });

  /** Un diálogo está centrado: el punto, respecto a su centro (el de la ventana). */
  it("centrado, el punto respecto al centro de la ventana", () => {
    click(window.innerWidth / 2 - 100, window.innerHeight / 2 + 40);
    expect(centeredOrigin()).toBe("calc(50% + -100px) calc(50% + 40px)");
  });

  /** Lo que se abre con el teclado mucho después no sale del último clic. */
  it("un clic viejo ya no cuenta", () => {
    vi.useFakeTimers();
    click(10, 10);
    vi.advanceTimersByTime(2000);
    expect(viewportOrigin()).toBe("50% 50%");
  });

  /** Se fija una vez: recalcularlo movería el origen a mitad de animación. */
  it("el ref lo fija al aparecer y no lo vuelve a tocar", () => {
    const el = document.createElement("div");
    click(50, 60);
    originRef("viewport")(el);
    click(500, 600);
    originRef("viewport")(el);
    expect(el.style.getPropertyValue("--motion-origin")).toBe("50px 60px");
  });

  it("un diálogo abierto tras un clic crece desde ahí", () => {
    click(window.innerWidth / 2 + 30, window.innerHeight / 2);
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Hola</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("dialog").style.getPropertyValue("--motion-origin")).toBe("calc(50% + 30px) calc(50% + 0px)");
  });
});
