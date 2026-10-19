import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useDismiss } from "@/hooks/use-dismiss";

/**
 * Un panel flotante se cierra al pulsar fuera o con Escape, como un menú. Los
 * de la llamada sólo se cerraban volviendo a pulsar su botón.
 */

afterEach(cleanup);

function Panel({ onDismiss, open = true }: { onDismiss: () => void; open?: boolean }) {
  const ref = useDismiss<HTMLDivElement>(open, onDismiss, "ajustes");
  return (
    <div>
      <button data-toggles="ajustes">abrir</button>
      <p>fuera</p>
      <div ref={ref}>
        <button>dentro</button>
      </div>
    </div>
  );
}

describe("cerrar un panel flotante", () => {
  it("pulsar fuera lo cierra; dentro, no", () => {
    const onDismiss = vi.fn();
    render(<Panel onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByText("dentro"));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText("fuera"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /** Su propio botón no es «fuera»: si no, lo cerraría y él lo reabriría. */
  it("su botón no cuenta como fuera", () => {
    const onDismiss = vi.fn();
    render(<Panel onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByText("abrir"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("Escape lo cierra", () => {
    const onDismiss = vi.fn();
    render(<Panel onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("cerrado (o yéndose), no escucha", () => {
    const onDismiss = vi.fn();
    render(<Panel onDismiss={onDismiss} open={false} />);
    fireEvent.pointerDown(screen.getByText("fuera"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
