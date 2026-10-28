import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Un guardado lleva la versión del cuerpo que se editó (`baseHash`); si no
 * coincide con la del servidor, éste lo toma por la edición de otro aparato y
 * cuelga una copia «(conflicting edit)». Hasta el 27-oct-2026 la base salía de
 * `detail`, y al salir de una nota con un guardado pendiente (con `/page`,
 * siempre) el vaciado iba con la base de la nota siguiente o vacía: la propia
 * edición chocaba consigo misma.
 */

const patch = vi.fn();
const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get, patch, post: vi.fn(), delete: vi.fn() } }));

const detailOf = (id: string, bodyHash: string) => ({
  success: true,
  data: { note: { id, title: id, body: "", bodyHash }, attachments: [], backlinks: [] },
});
const saved = (id: string, bodyHash: string) => ({
  success: true,
  data: { note: { id, title: id, body: "", bodyHash } },
});

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  patch.mockReset();
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/notes/")) return { success: true, data: [] };
    const id = url.split("/").pop()!;
    return detailOf(id, `hash-${id}`);
  });
});

describe("la base de un guardado", () => {
  it("es la de la nota que se guarda aunque ya se esté viendo otra", async () => {
    const { useNotesStore } = await import("@/store/notes.store");
    await useNotesStore.getState().openNote("madre");
    // Se entra en la hija; el vaciado del autoguardado de la madre llega después.
    const opening = useNotesStore.getState().openNote("hija");
    patch.mockResolvedValue(saved("madre", "hash-madre-2"));
    await useNotesStore.getState().saveBody("madre", "con el bloque");
    await opening;
    expect(patch).toHaveBeenCalledWith("/api/v1/notes/madre", { body: "con el bloque", baseHash: "hash-madre" });
  });

  it("dos guardados seguidos: el segundo espera al primero y lleva su versión", async () => {
    const { useNotesStore } = await import("@/store/notes.store");
    await useNotesStore.getState().openNote("n");
    let release!: () => void;
    patch.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(saved("n", "hash-n-2")))),
    );
    patch.mockResolvedValueOnce(saved("n", "hash-n-3"));
    const first = useNotesStore.getState().saveBody("n", "uno");
    const second = useNotesStore.getState().saveBody("n", "dos");
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(patch).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(patch.mock.calls[1]).toEqual(["/api/v1/notes/n", { body: "dos", baseHash: "hash-n-2" }]);
  });
});
