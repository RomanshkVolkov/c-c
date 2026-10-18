import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useFollowLog } from "@/hooks/use-follow-log";

/**
 * Un log que baja solo mientras se está abajo, y que deja en paz a quien subió
 * a leer.
 */

afterEach(cleanup);

function Log({ text }: { text: string }) {
  const { ref, onScroll } = useFollowLog<HTMLPreElement>(text);
  return (
    <pre data-testid="log" ref={ref} onScroll={onScroll}>
      {text}
    </pre>
  );
}

/** jsdom no maqueta: la altura de la caja y la del contenido se dicen a mano. */
function box(el: HTMLElement, scrollHeight: number, clientHeight = 100) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

describe("un log que sigue", () => {
  it("baja con cada línea nueva", () => {
    const { getByTestId, rerender } = render(<Log text="uno" />);
    const el = getByTestId("log");
    box(el, 500);
    rerender(<Log text={"uno\ndos"} />);
    expect(el.scrollTop).toBe(500);
  });

  it("si subes a leer, no te mueve", () => {
    const { getByTestId, rerender } = render(<Log text="uno" />);
    const el = getByTestId("log");
    box(el, 500);
    el.scrollTop = 120;
    fireEvent.scroll(el);
    box(el, 600);
    rerender(<Log text={"uno\ndos"} />);
    expect(el.scrollTop).toBe(120);
  });

  it("y al volver abajo, sigue otra vez", () => {
    const { getByTestId, rerender } = render(<Log text="uno" />);
    const el = getByTestId("log");
    box(el, 500);
    el.scrollTop = 120;
    fireEvent.scroll(el);
    el.scrollTop = 395; // a 5px del final
    fireEvent.scroll(el);
    box(el, 700);
    rerender(<Log text={"uno\ndos"} />);
    expect(el.scrollTop).toBe(700);
  });
});
