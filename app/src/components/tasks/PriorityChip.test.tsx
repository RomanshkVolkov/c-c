import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import PriorityChip, { priorityDot } from "@/components/tasks/PriorityChip";
import { applyLocale } from "@/lib/i18n";

afterEach(() => {
  cleanup();
  act(() => applyLocale("en"));
});

describe("el chip de prioridad", () => {
  it("lleva su color y su nombre del catálogo", () => {
    render(<PriorityChip priority="urgent" />);
    const chip = screen.getByText("Urgent");
    expect(chip.className).toContain("bg-error/15");
    expect(chip.className).toContain("text-error");
  });

  it("y en castellano, en castellano", () => {
    act(() => applyLocale("es"));
    render(<PriorityChip priority="high" />);
    expect(screen.getByText("Alta")).toBeTruthy();
  });

  /** La guardada `medium` es la `normal` de la API (CLAUDE.md). */
  it("medium se pinta como normal", () => {
    render(<PriorityChip priority="medium" />);
    expect(screen.getByText("Medium").className).toContain("text-info");
  });

  it("sin prioridad no pinta nada, salvo que se pida", () => {
    const { container } = render(<PriorityChip priority="none" />);
    expect(container.textContent).toBe("");
    render(<PriorityChip priority="none" showNone />);
    expect(screen.getByText("No priority")).toBeTruthy();
  });

  it("una que no conoce se enseña por su nombre", () => {
    render(<PriorityChip priority="critica" />);
    expect(screen.getByText("critica")).toBeTruthy();
  });
});

/**
 * El punto del calendario es un fondo: con el color de texto que daba
 * `PRIORITY_META` no se pintaba nada (los puntos de «Mi trabajo» eran
 * invisibles). El mutante que mata: volver a la clase de texto.
 */
describe("el punto de una prioridad", () => {
  it("es un fondo de su color", () => {
    expect(priorityDot("urgent")).toBe("bg-error");
    expect(priorityDot("medium")).toBe("bg-info");
    expect(priorityDot("rara")).toBe("bg-muted-foreground");
  });
});
