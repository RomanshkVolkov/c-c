import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The row actions of the spaces tree must not be hidden until you hover.
 *
 * Every `+` and `⋯` in the navigator was `opacity-0 group-hover:opacity-100`.
 * That does **not** take a button out of the tab order — so keyboard focus
 * lands on it perfectly well, and lands on something invisible. You tab into
 * the tree and the focus ring disappears. That is the defect: not "hard to
 * find with a mouse" but "unusable without one".
 *
 * Asserted on the class rather than on computed style because jsdom applies no
 * CSS at all: `toBeVisible()` cannot see an opacity set by Tailwind, so the
 * only honest way to encode "not hidden until hover" is the very class that
 * does the hiding.
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
  folders: [{ id: "fo-1", spaceId: "sp-1", name: "Backend", lists: [] }],
  lists: [{ id: "li-1", spaceId: "sp-1", name: "Pendientes" }],
};

beforeEach(() => {
  useTasksStore.setState({ tree: [unEspacio], loadingTree: false, error: null } as never);
});

const montar = () =>
  render(
    // Needs a router since the tree moved to the global sidebar: picking a list
    // now navigates to the board instead of quietly changing one nobody is on.
    <MemoryRouter>
      <ConfirmProvider>
        <PromptProvider>
          <SpacesNavigator />
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

describe("acciones de fila del árbol", () => {
  it("no se esconden hasta pasar el ratón", () => {
    montar();
    const escondidos = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("opacity-0"));
    expect(
      escondidos.map((b) => b.getAttribute("aria-label") ?? b.getAttribute("title") ?? "?"),
    ).toEqual([]);
  });

  it("cada acción se puede nombrar, que es lo que anuncia un lector de pantalla", () => {
    montar();
    const sinNombre = screen
      .getAllByRole("button")
      .filter((b) => !b.getAttribute("aria-label") && !b.getAttribute("title") && !b.textContent?.trim());
    expect(sinNombre).toEqual([]);
  });
});
