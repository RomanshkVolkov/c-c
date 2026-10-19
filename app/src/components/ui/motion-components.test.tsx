import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TabIndicator from "@/components/ui/tab-indicator";
import { Popover } from "@/components/ui/popover";
import { useSlidingIndicator } from "@/lib/use-sliding-indicator";

/**
 * Los componentes compartidos del movimiento: el indicador que se desliza, el
 * popover con muelle.
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

function LateBar({ show }: { show: boolean }) {
  const { ref, rect, first } = useSlidingIndicator<HTMLDivElement>("a");
  return show ? (
    <div ref={ref} className="relative">
      <button aria-pressed>a</button>
      <TabIndicator rect={rect} first={first} />
    </div>
  ) : null;
}

/**
 * Una barra que aparece después que su componente (las pestañas de una
 * respuesta HTTP, la barra del teléfono al cerrar el teclado) también se
 * mide. El mutante que mata: volver a un `useRef`, que no avisa.
 */
describe("una barra que aparece más tarde", () => {
  it("se mide al aparecer, sin que cambie la pestaña activa", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(30);
    const { container, rerender } = render(<LateBar show={false} />);
    rerender(<LateBar show />);
    expect(container.querySelector('[data-slot="tab-indicator"]')).not.toBeNull();
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
