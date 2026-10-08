import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/** El índice dice cuántas páginas tiene cada documento. */

const estado = {
  tree: [{ id: "s1", name: "Proteus", lists: [{ id: "l1", name: "Apps", taskCount: 3 }], folders: [] }],
  docIndex: { "list:l1": { written: true, pages: 7, maintainerName: "Ana" } },
  openDoc: vi.fn(),
};
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: unknown) => unknown) => sel(estado),
}));
vi.mock("@/types/task", async (orig) => ({
  ...(await orig<typeof import("@/types/task")>()),
  docKey: (kind: string, id: string) => `${kind}:${id}`,
}));

const { default: DocIndex } = await import("@/components/docs/DocIndex");

afterEach(cleanup);

describe("el índice de la documentación", () => {
  it("cuenta las páginas de cada documento", () => {
    render(<DocIndex />);
    expect(screen.getByText("Pages")).toBeTruthy();
    const fila = screen.getByText("Apps").closest("tr")!;
    expect([...fila.querySelectorAll("td")].map((c) => c.textContent)).toContain("7");
  });
});
