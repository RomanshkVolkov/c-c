import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Each tab is a different question asked of the server, not a slice of one big
 * download.
 *
 * That distinction is the point of the store: "every open task in the
 * organization" is not something worth shipping to a client so it can throw
 * most of it away, and it is not something a client should be holding either.
 * So the test that matters is which query each lens sends.
 */

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get, post: vi.fn(), delete: vi.fn() },
}));

const { useMyWorkStore } = await import("@/store/mywork.store");
type WorkLens = Parameters<ReturnType<typeof useMyWorkStore.getState>["setLens"]>[0];

afterEach(() => {
  get.mockReset();
  useMyWorkStore.setState({ lens: "assigned", includeClosed: false, tasks: [] });
});

const urlPedida = async () => {
  get.mockResolvedValue({ success: true, data: [] });
  await useMyWorkStore.getState().load("org-1");
  return String(get.mock.calls[0][0]);
};

describe("las lentes de «mi trabajo»", () => {
  it("preguntan cada una lo suyo", async () => {
    const casos: [WorkLens, string][] = [
      ["assigned", "assignee=me"],
      ["created", "creator=me"],
      ["watching", "watcher=me"],
      ["clients", "origin=clients"],
    ];
    for (const [lens, esperado] of casos) {
      useMyWorkStore.setState({ lens });
      get.mockReset();
      expect(await urlPedida()).toContain(esperado);
    }
  });

  it("«todas» no restringe por persona", async () => {
    useMyWorkStore.setState({ lens: "all" });
    const url = await urlPedida();
    expect(url).not.toContain("assignee=");
    expect(url).not.toContain("creator=");
    expect(url).not.toContain("watcher=");
  });

  it("las cerradas sólo se piden si las pides", async () => {
    expect(await urlPedida()).not.toContain("status=all");
    get.mockReset();
    useMyWorkStore.setState({ includeClosed: true });
    expect(await urlPedida()).toContain("status=all");
  });

  it("siempre va acotada a la organización", async () => {
    expect(await urlPedida()).toContain("orgId=org-1");
  });

  it("un fallo deja la lista vacía y el motivo a la vista, no datos viejos", async () => {
    useMyWorkStore.setState({ tasks: [{ id: "t-1" }] as never });
    get.mockRejectedValue(new Error("sin red"));
    await useMyWorkStore.getState().load("org-1");
    expect(useMyWorkStore.getState().tasks).toEqual([]);
    expect(useMyWorkStore.getState().error).toContain("sin red");
  });
});

describe("el alcance que pone el árbol", () => {
  it("no se recuerda entre sesiones", () => {
    // Sólo se persisten la lente y el interruptor: reabrir la app apuntando a
    // una lista que ya no recuerdas haber elegido es un filtro que parece
    // ausencia de datos.
    const guardado = JSON.parse(
      localStorage.getItem("cac-mywork") ?? '{"state":{}}',
    ).state as Record<string, unknown>;
    useMyWorkStore.setState({ scope: { kind: "list", id: "li-1", name: "Una" } });
    const despues = JSON.parse(
      localStorage.getItem("cac-mywork") ?? '{"state":{}}',
    ).state as Record<string, unknown>;
    expect(despues.scope).toBeUndefined();
    expect(Object.keys(despues).sort()).toEqual(Object.keys(guardado).sort());
  });

  it("no cambia la pregunta que se le hace al servidor", async () => {
    get.mockResolvedValue({ success: true, data: [] });
    useMyWorkStore.setState({ lens: "assigned", scope: { kind: "list", id: "li-1", name: "Una" } });
    await useMyWorkStore.getState().load("org-1");
    // El alcance acota en el cliente: la lente sigue siendo la pregunta, y
    // mandarlo al servidor sería una segunda forma de decir lo mismo.
    expect(String(get.mock.calls[0][0])).toContain("assignee=me");
    expect(String(get.mock.calls[0][0])).not.toContain("li-1");
  });
});
