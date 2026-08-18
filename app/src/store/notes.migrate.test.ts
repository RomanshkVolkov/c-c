import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * State written by an older build must not crash the newer one.
 *
 * The notes store caches the open page so reopening it is instant. That cache
 * outlives the build that wrote it: a page cached before `backlinks` existed
 * comes back without the field, and `detail.backlinks.length` took the whole
 * screen down — while the type said it was there and the server was sending it
 * correctly the whole time.
 *
 * The fix is a version on the persisted state. This checks it actually drops
 * the stale shape instead of handing it back.
 */

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

const VIEJO = {
  state: {
    tree: [],
    activeId: "n-1",
    // Escrito por una versión anterior: sin `backlinks`.
    detail: { note: { id: "n-1", title: "Vieja" }, attachments: [] },
    pendingWrites: [],
  },
  version: 1,
};

beforeEach(() => {
  localStorage.setItem("cac-notes", JSON.stringify(VIEJO));
  vi.resetModules();
});
afterEach(() => localStorage.clear());

describe("el estado persistido de notas", () => {
  it("tira el detalle escrito por una versión anterior", async () => {
    const { useNotesStore } = await import("@/store/notes.store");
    await useNotesStore.persist.rehydrate();
    // Es una caché: soltarla no pierde nada, y la siguiente lectura la rellena.
    expect(useNotesStore.getState().detail).toBeNull();
    // Y lo que no cambió de forma se conserva.
    expect(useNotesStore.getState().activeId).toBe("n-1");
  });

  it("no tira nada si ya venía de una versión al día", async () => {
    localStorage.setItem(
      "cac-notes",
      JSON.stringify({
        ...VIEJO,
        version: 2,
        state: { ...VIEJO.state, detail: { note: { id: "n-1" }, attachments: [], backlinks: [] } },
      }),
    );
    const { useNotesStore } = await import("@/store/notes.store");
    await useNotesStore.persist.rehydrate();
    expect(useNotesStore.getState().detail).not.toBeNull();
  });
});
