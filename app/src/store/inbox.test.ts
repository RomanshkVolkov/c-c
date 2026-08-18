import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The badge has to mean "since you last read it".
 *
 * It used to mean "since you last launched me", because the count came from
 * what this session happened to witness over the event stream. The two things
 * this store must get right are that the count comes from the server, and that
 * reading is optimistic without ever going negative — a double click on the
 * same row must not invent unread items or lose them.
 */

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get, post, patch } }));

const { useInboxStore } = await import("@/store/inbox.store");

afterEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  useInboxStore.setState({ items: [], unread: 0, orgId: null, loading: false, prefs: null });
});

const item = (id: string, leido = false) => ({
  id, orgId: "org-1", kind: "chat:mention", title: id, body: "", link: "/chat",
  readAt: leido ? "ayer" : null, createdAt: "hoy",
});

describe("el buzón", () => {
  it("toma el contador del servidor, no de lo que tenga en pantalla", async () => {
    get.mockResolvedValue({ success: true, data: { items: [item("a")], unread: 37 } });
    await useInboxStore.getState().load("org-1");
    expect(useInboxStore.getState().items).toHaveLength(1);
    // Más de los que caben en la página: eso es exactamente lo que el contador
    // del servidor sabe y el cliente no puede deducir.
    expect(useInboxStore.getState().unread).toBe(37);
  });

  it("va acotado a la organización", async () => {
    get.mockResolvedValue({ success: true, data: { items: [], unread: 0 } });
    await useInboxStore.getState().load("org-9");
    expect(String(get.mock.calls[0][0])).toContain("orgId=org-9");
  });

  it("leer descuenta una vez, aunque pulses dos veces", async () => {
    useInboxStore.setState({ items: [item("a"), item("b")], unread: 2 });
    post.mockResolvedValue({ success: true });
    await useInboxStore.getState().markRead(["a"]);
    expect(useInboxStore.getState().unread).toBe(1);
    await useInboxStore.getState().markRead(["a"]);
    expect(useInboxStore.getState().unread).toBe(1);
  });

  it("el contador nunca baja de cero", async () => {
    useInboxStore.setState({ items: [item("a", true)], unread: 0 });
    post.mockResolvedValue({ success: true });
    await useInboxStore.getState().markRead(["a"]);
    expect(useInboxStore.getState().unread).toBe(0);
  });

  it("un fallo al cargar no interrumpe a nadie", async () => {
    get.mockRejectedValue(new Error("sin red"));
    await useInboxStore.getState().load("org-1");
    expect(useInboxStore.getState().loading).toBe(false);
  });
});

describe("las preferencias", () => {
  it("se guardan y el servidor tiene la última palabra", async () => {
    patch.mockResolvedValue({
      success: true,
      // El servidor devuelve las menciones en true aunque se hayan mandado en
      // false: forzarlas y contestar la verdad es lo que impide que el diálogo
      // afirme algo que no va a pasar.
      data: { mentions: true, dms: false, comments: true, reports: true },
    });
    await useInboxStore
      .getState()
      .savePrefs({ mentions: false, dms: false, comments: true, reports: true, messages: true });

    expect(patch).toHaveBeenCalled();
    expect(useInboxStore.getState().prefs?.mentions).toBe(true);
    expect(useInboxStore.getState().prefs?.dms).toBe(false);
  });

  it("un fallo al leerlas no interrumpe a nadie", async () => {
    get.mockRejectedValue(new Error("sin red"));
    await useInboxStore.getState().loadPrefs();
    // Sin preferencias el diálogo abre con los valores por defecto, que es lo
    // que de verdad tiene alguien que nunca las tocó.
    expect(useInboxStore.getState().prefs).toBeNull();
  });
});
