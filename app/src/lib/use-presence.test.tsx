import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_MS, useExitThen, usePresence } from "@/lib/use-presence";
import { removeWithExit } from "@/lib/dom-exit";

/**
 * Las salidas: lo que se cierra sigue montado el rato que tarda en irse.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Box({ open }: { open: boolean }) {
  const p = usePresence(open);
  return p.present ? <div data-testid="box" data-closing={p.closing || undefined} /> : null;
}

const box = () => screen.queryByTestId("box");

describe("algo que se cierra", () => {
  it("se queda saliendo y después se va", () => {
    const { rerender } = render(<Box open />);
    rerender(<Box open={false} />);
    expect(box()?.hasAttribute("data-closing")).toBe(true);
    act(() => vi.advanceTimersByTime(EXIT_MS - 1));
    expect(box()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(box()).toBeNull();
  });

  /** Lo que empieza cerrado y se abre después también sale al cerrarse. */
  it("abierto después de montarse, también sale", () => {
    const { rerender } = render(<Box open={false} />);
    rerender(<Box open />);
    rerender(<Box open={false} />);
    expect(box()?.hasAttribute("data-closing")).toBe(true);
  });

  /** Si se vuelve a abrir mientras se va, se queda, sin parpadear. */
  it("reabierto a mitad de la salida, se queda", () => {
    const { rerender } = render(<Box open />);
    rerender(<Box open={false} />);
    rerender(<Box open />);
    act(() => vi.advanceTimersByTime(EXIT_MS * 2));
    expect(box()).not.toBeNull();
    expect(box()!.hasAttribute("data-closing")).toBe(false);
  });

  it("lo que nunca se abrió no aparece", () => {
    render(<Box open={false} />);
    expect(box()).toBeNull();
  });

  it("con movimiento reducido se va en el acto", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const { rerender } = render(<Box open />);
    rerender(<Box open={false} />);
    expect(box()).toBeNull();
  });
});

function Viewer({ onClose }: { onClose: () => void }) {
  const exit = useExitThen(onClose);
  return (
    <button data-testid="viewer" data-closing={exit.leaving || undefined} onClick={exit.leave}>
      cerrar
    </button>
  );
}

/**
 * Lo que se cierra desde dentro (el detalle de una tarea, los visores): la
 * salida primero y el cierre al acabar. Sustituye a las View Transitions, que
 * tumbaban el proceso de WebKitGTK.
 */
describe("cerrar con salida desde dentro", () => {
  it("sale, y al acabar cierra una sola vez", () => {
    const onClose = vi.fn();
    render(<Viewer onClose={onClose} />);
    act(() => screen.getByTestId("viewer").click());
    act(() => screen.getByTestId("viewer").click());
    expect(screen.getByTestId("viewer").hasAttribute("data-closing")).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("con movimiento reducido, cierra en el acto", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const onClose = vi.fn();
    render(<Viewer onClose={onClose} />);
    act(() => screen.getByTestId("viewer").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("un elemento hecho a mano (los menús del editor)", () => {
  it("sale y después se quita", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    removeWithExit(el);
    expect(el.hasAttribute("data-closing")).toBe(true);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(EXIT_MS);
    expect(el.isConnected).toBe(false);
  });

  it("si ya estaba oculto, se quita en el acto", () => {
    const el = document.createElement("div");
    el.style.display = "none";
    document.body.appendChild(el);
    removeWithExit(el);
    expect(el.isConnected).toBe(false);
  });
});

describe("las salidas del CSS", () => {
  /**
   * Ninguna dura más de lo que `usePresence` las deja montadas: si durara
   * más, se cortaría a la mitad. El mutante que mata: alargar una salida sin
   * tocar `EXIT_MS`.
   */
  it("caben en EXIT_MS", () => {
    const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
    const rules = [...css.matchAll(/\[data-closing\]\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rules.length).toBeGreaterThanOrEqual(4);
    const durations = rules.flatMap((r) => [...r.matchAll(/(\d+)ms/g)].map((m) => Number(m[1])));
    expect(Math.max(...durations)).toBeLessThanOrEqual(EXIT_MS);
  });
});
