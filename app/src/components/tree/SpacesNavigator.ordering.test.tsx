import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The lock, and what "locked" has to mean.
 *
 * Closed by default because the tree is mostly something you click, and a click
 * that turns into a drag by accident moves somebody's work somewhere nobody
 * chose. What matters here is the difference between *disabled* and *absent*:
 * a disabled drag handle still sits under the pointer and still answers to the
 * keyboard, and dnd-kit still registers its drop targets. So this asserts the
 * handles are not in the document at all until the lock is opened.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter } = await import("react-router-dom");
const { default: SpacesNavigator } = await import("@/components/tree/SpacesNavigator");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { useTasksStore } = await import("@/store/tasks.store");

const unEspacio = {
  id: "sp-1",
  orgId: "org-1",
  name: "Ingeniería",
  color: "#888888",
  folders: [{ id: "fo-1", name: "Backend", folders: [], lists: [] }],
  lists: [{ id: "li-1", name: "Pendientes", taskCount: 0 }],
};

beforeEach(() => {
  useTasksStore.setState({ tree: [unEspacio], loadingTree: false, error: null } as never);
});
afterEach(cleanup);

const montar = () =>
  render(
    <MemoryRouter>
      <ConfirmProvider>
        <PromptProvider>
          <SpacesNavigator />
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

const asas = (c: HTMLElement) => c.querySelectorAll(".cursor-grab");

describe("el candado de orden", () => {
  it("empieza cerrado", () => {
    montar();
    expect(screen.getByTitle("Rearrange").getAttribute("aria-pressed")).toBe("false");
  });

  it("cerrado, no hay asas de arrastre en el documento", () => {
    const { container } = montar();
    expect(asas(container).length).toBe(0);
  });

  it("abierto, las filas se pueden coger", () => {
    const { container } = montar();
    fireEvent.click(screen.getByTitle("Rearrange"));
    // Un folder y una lista.
    expect(asas(container).length).toBe(2);
    expect(screen.getByTitle("Finish rearranging")).toBeTruthy();
  });

  it("y al volver a cerrarlo desaparecen otra vez", () => {
    const { container } = montar();
    fireEvent.click(screen.getByTitle("Rearrange"));
    fireEvent.click(screen.getByTitle("Finish rearranging"));
    expect(asas(container).length).toBe(0);
  });
});
