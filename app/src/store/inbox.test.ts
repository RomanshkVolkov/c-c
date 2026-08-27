import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("marcar una conversación entera", () => {
  beforeEach(() => {
    post.mockClear();
    useInboxStore.setState({
      items: [
        { id: "a", groupKey: "space:s1", readAt: null },
        { id: "b", groupKey: "space:s1", readAt: null },
        { id: "c", groupKey: "dm:c7", readAt: null },
      ] as never,
      unread: 40,
      groups: [
        { key: "space:s1", label: "#portento", total: 47, unread: 35 },
        { key: "dm:c7", label: "Ana", total: 1, unread: 1 },
      ],
      orgId: "org-9",
    });
  });

  // Por clave y no por ids: los que tiene la app son los que cupieron en la
  // página. Marcando por ids, la fila diría cero y el badge se quedaría en 35.
  it("lo pide por clave, no por los ids que tenga a mano", async () => {
    await useInboxStore.getState().markReadGroup("space:s1");
    const [url, cuerpo] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("/api/v1/notifications/read");
    expect(cuerpo.group).toBe("space:s1");
    expect(cuerpo).not.toHaveProperty("ids");
  });

  // El servidor sabe cuántas hay de verdad; la app sólo ve las cargadas.
  it("el contador baja por las que hay en la base, no por las cargadas", async () => {
    await useInboxStore.getState().markReadGroup("space:s1");
    expect(useInboxStore.getState().unread).toBe(5); // 40 − 35, no 40 − 2
  });

  it("y deja esa conversación a cero", async () => {
    await useInboxStore.getState().markReadGroup("space:s1");
    const g = useInboxStore.getState().groups.find((x) => x.key === "space:s1");
    expect(g?.unread).toBe(0);
  });

  it("sin tocar las demás", async () => {
    await useInboxStore.getState().markReadGroup("space:s1");
    const s = useInboxStore.getState();
    expect(s.items.find((i) => i.id === "c")?.readAt).toBeNull();
    expect(s.groups.find((x) => x.key === "dm:c7")?.unread).toBe(1);
  });

  it("marca las suyas que estén cargadas", async () => {
    await useInboxStore.getState().markReadGroup("space:s1");
    const s = useInboxStore.getState();
    expect(s.items.filter((i) => i.groupKey === "space:s1").every((i) => i.readAt)).toBe(true);
  });

  it("nunca baja de cero", async () => {
    useInboxStore.setState({ unread: 3 });
    await useInboxStore.getState().markReadGroup("space:s1");
    expect(useInboxStore.getState().unread).toBe(0);
  });

  it("una clave vacía no manda nada", async () => {
    await useInboxStore.getState().markReadGroup("");
    expect(post).not.toHaveBeenCalled();
  });
});
