import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import TabIndicator from "@/components/ui/tab-indicator";
import { Popover } from "@/components/ui/popover";
import { useSlidingIndicator } from "@/lib/use-sliding-indicator";
import { withViewTransition } from "@/lib/view-transition";

/**
 * Los componentes compartidos del movimiento: el indicador que se desliza, el
 * popover con muelle y la salida con View Transition.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Bar({ value }: { value: string }) {
  const { ref, rect, first } = useSlidingIndicator<HTMLDivElement>(value);
  return (
    <div ref={ref} className="relative">
      {["a", "b"].map((v) => (
        <button key={v} aria-pressed={v === value}>
          {v}
        </button>
      ))}
      <TabIndicator rect={rect} first={first} variant="pill" />
    </div>
  );
}

describe("el indicador de una barra de pestañas", () => {
  it("sin layout no se pinta", () => {
    const { container } = render(<Bar value="a" />);
    expect(container.querySelector('[data-slot="tab-indicator"]')).toBeNull();
  });

  /**
   * La primera vez aparece en su sitio; después, se desliza. Si se deslizara
   * desde el principio, cada barra entraría con la pastilla volando desde la
   * esquina.
   */
  it("aparece en su sitio y después se desliza", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(30);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    const left = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(0);
    const { container, rerender } = render(<Bar value="a" />);
    const pill = () => container.querySelector('[data-slot="tab-indicator"]') as HTMLElement;
    expect(pill().className).not.toContain("transition-");
    left.mockReturnValue(40);
    rerender(<Bar value="b" />);
    expect(pill().className).toContain("transition-[translate,width,height]");
    expect(pill().style.translate).toBe("40px 0px");
    expect(pill().style.height).toBe("20px");
  });
});

describe("el popover", () => {
  it("se abre desde su botón con el movimiento de la app", async () => {
    render(
      <Popover trigger={<button>abrir</button>}>
        <p>dentro</p>
      </Popover>,
    );
    fireEvent.click(screen.getByText("abrir"));
    const content = await screen.findByText("dentro");
    expect(content.parentElement!.className).toContain("motion-pop");
  });
});

describe("salir con una View Transition", () => {
  it("sin soporte, cambia en el acto", () => {
    const change = vi.fn();
    withViewTransition(change);
    expect(change).toHaveBeenCalledTimes(1);
  });

  it("con soporte, el cambio va dentro de la transición", () => {
    const change = vi.fn();
    const start = vi.fn((cb: () => void) => cb());
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    act(() => withViewTransition(change));
    expect(start).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledTimes(1);
    delete (document as unknown as Record<string, unknown>).startViewTransition;
  });

  /** Quien pide menos movimiento no recibe ni esta. */
  it("con movimiento reducido, en el acto aunque haya soporte", () => {
    const start = vi.fn();
    Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const change = vi.fn();
    withViewTransition(change);
    expect(start).not.toHaveBeenCalled();
    expect(change).toHaveBeenCalledTimes(1);
    delete (document as unknown as Record<string, unknown>).startViewTransition;
  });
});
