import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * El historial enseña qué cambió antes de restaurar: en rojo lo que había y ya
 * no está, en verde lo que se escribió después. Restaurar a ciegas —sólo con la
 * fecha— es cómo se pierde el párrafo bueno de esta mañana.
 */

vi.mock("@/store/tasks.store", () => ({ useTasksStore: () => vi.fn() }));

const { VersionMenu } = await import("@/components/docs/DocHistory");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

afterEach(cleanup);

const montar = (restore = vi.fn(async () => {})) => {
  render(
    <ConfirmProvider>
      <VersionMenu
        current={"# Nereus\nahora dice esto\nfin"}
        load={async () => [
          { id: "v1", createdAt: "2026-10-08T10:00:00Z", authorName: "Ana", body: "# Nereus\nantes decía esto\nfin" },
        ]}
        restore={restore}
      />
    </ConfirmProvider>,
  );
  return restore;
};

describe("el historial", () => {
  it("si se cancela la pregunta, no restaura", async () => {
    const restore = montar();
    fireEvent.click(screen.getByText("History"));
    fireEvent.click(await screen.findByText("Ana"));
    fireEvent.click(await screen.findByText("Restore this version"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(restore).not.toHaveBeenCalled();
  });

  it("una versión enseña lo que cambió desde ella", async () => {
    montar();
    fireEvent.click(screen.getByText("History"));
    fireEvent.click(await screen.findByText("Ana"));
    const dialogo = await screen.findByRole("dialog");
    const del = dialogo.querySelector('[data-kind="del"]')!;
    const add = dialogo.querySelector('[data-kind="add"]')!;
    expect(del.textContent).toContain("antes decía esto");
    expect(add.textContent).toContain("ahora dice esto");
    expect(dialogo.textContent).toContain("+1");
  });

  it("y desde ahí se restaura, preguntando antes", async () => {
    const restore = montar();
    fireEvent.click(screen.getByText("History"));
    fireEvent.click(await screen.findByText("Ana"));
    fireEvent.click(await screen.findByText("Restore this version"));
    // Todavía no: primero pregunta.
    expect(await screen.findByRole("button", { name: "Restore" })).toBeTruthy();
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("v1"));
  });
});
