import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import KanbanBoard from "@/components/kanban/KanbanBoard";
import { statusTone } from "@/lib/status-color";

/**
 * Una columna con tono se distingue de las demás: filo de arriba, punto y
 * cuenta en el color de su estado. Sin tono, la cuenta queda apagada.
 */

afterEach(cleanup);

const board = (tone?: ReturnType<typeof statusTone>) =>
  render(
    <KanbanBoard
      columns={[{ id: "c1", title: "En curso", tone }]}
      items={[{ id: "a", columnId: "c1" }]}
      emptyColumnHint="—"
      onMove={() => {}}
      renderItem={() => <p>tarjeta</p>}
    />,
  );

describe("el color de una columna", () => {
  it("filo, punto y cuenta en el color de su estado", () => {
    board(statusTone("in_progress"));
    const column = screen.getByText("En curso").closest("section")!;
    expect(column.className).toContain("border-t-status-progress");
    expect(column.className).toContain("bg-sunken");
    expect(column.querySelector(".bg-status-progress")).not.toBeNull();
    expect(screen.getByText("1").className).toContain("bg-status-progress/15");
  });

  it("sin tono, ni filo ni punto", () => {
    board();
    const column = screen.getByText("En curso").closest("section")!;
    expect(column.className).not.toContain("border-t-2");
    expect(screen.getByText("1").className).toContain("text-muted-foreground");
  });
});
