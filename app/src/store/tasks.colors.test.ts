import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cambiar el color de un espacio o una etiqueta.
 *
 * El espacio manda su nombre con el color porque el servidor lo pide para
 * renombrar. La etiqueta va copiada dentro de cada tarjeta y del detalle
 * abierto, y el color nuevo tiene que verse en los tres sitios sin recargar.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));

const { useTasksStore } = await import("@/store/tasks.store");

const tag = (color: string) => ({ id: "g1", orgId: "o", name: "bug", color });

beforeEach(() => {
  api.get.mockResolvedValue({ success: true, data: [] });
});

describe("el color", () => {
  it("de un espacio se manda con su nombre", async () => {
    api.patch.mockResolvedValue({ success: true });
    await useTasksStore.getState().setSpaceColor("sp-1", "Producto", "#22C55E");
    expect(api.patch).toHaveBeenCalledWith("/api/v1/task-spaces/sp-1", { name: "Producto", color: "#22C55E" }, true);
  });

  it("de una etiqueta cambia en la lista, en las tarjetas y en el detalle", async () => {
    api.patch.mockResolvedValue({ success: true, data: tag("#EF4444") });
    useTasksStore.setState({
      tags: [tag("#8B5CF6")],
      board: { list: { id: "l" }, statuses: [], tasks: [{ id: "t1", tags: [tag("#8B5CF6")] }] },
      detail: { tags: [tag("#8B5CF6")] },
    } as never);
    await useTasksStore.getState().setTagColor("g1", "#EF4444");
    const s = useTasksStore.getState();
    expect(api.patch).toHaveBeenCalledWith("/api/v1/task-tags/g1", { color: "#EF4444" }, true);
    expect(s.tags[0].color).toBe("#EF4444");
    expect(s.board!.tasks[0].tags[0].color).toBe("#EF4444");
    expect(s.detail!.tags[0].color).toBe("#EF4444");
  });
});
