import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ColorDot, ColorSwatches, PALETTE, paletteFor } from "@/components/ui/color-swatches";
import TagChip from "@/components/tasks/TagChip";

afterEach(cleanup);

describe("elegir un color", () => {
  it("pulsar uno llama con su hex, y el actual sale marcado", () => {
    const onChange = vi.fn();
    render(<ColorSwatches value="#22c55e" onChange={onChange} />);
    // El actual, aunque llegue en minúsculas.
    expect(screen.getByRole("button", { name: "Green" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Blue" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Red" }));
    expect(onChange).toHaveBeenCalledWith("#EF4444");
  });

  it("el punto abre la paleta y elegir cambia el color", async () => {
    const onChange = vi.fn();
    render(<ColorDot color="#3B82F6" label="Color de Producto" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Color de Producto" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pink" }));
    expect(onChange).toHaveBeenCalledWith("#EC4899");
  });

  /**
   * Pulsar el punto de un espacio no abre ni pliega el espacio: el punto está
   * dentro de la fila, y el clic subía hasta ella.
   */
  it("el clic del punto no llega a la fila", () => {
    const row = vi.fn();
    render(
      <div onClick={row}>
        <ColorDot color="#3B82F6" label="Color" onChange={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Color" }));
    expect(row).not.toHaveBeenCalled();
  });

  it("una etiqueta nueva toma un color de la paleta, el mismo para el mismo nombre", () => {
    expect(paletteFor("bug")).toBe(paletteFor("bug"));
    expect(PALETTE.map((c) => c.hex)).toContain(paletteFor("bug"));
    const seen = new Set(["bug", "ui", "datos", "pagos", "backend", "web", "app", "infra", "docs", "ops", "qa", "seo"].map(paletteFor));
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe("una etiqueta", () => {
  /** El nombre en el color del texto: un amarillo como texto no se lee en claro. */
  it("su color va en el punto y el fondo, no en el nombre", () => {
    render(<TagChip name="bug" color="#EAB308" />);
    const chip = screen.getByText("bug");
    expect(chip.className).toContain("text-foreground");
    expect(chip.style.color).toBe("");
    expect(chip.querySelector("span")!.style.backgroundColor).toBe("rgb(234, 179, 8)");
  });
});
