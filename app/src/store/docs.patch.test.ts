import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cambiar el responsable no puede borrar lo que se está leyendo.
 *
 * `patchDoc` toca metadatos —dueño, revisión, línea fijada— y **no** el texto.
 * Recargar el documento entero para eso haría parpadear la pestaña que se tiene
 * delante, y en un runbook largo eso significa perder el sitio. Se funde la
 * respuesta sobre lo que ya hay, que es la invariante que se prueba aquí.
 */

const patch = vi.fn(async (_p: string, body: unknown) => ({
  success: true,
  data: { id: "d1", orgId: "o1", ...(body as object), stale: false },
}));
const get = vi.fn(async (_p: string) => ({ success: true, data: {} }));
// El PUT devuelve el documento entero, con el hash nuevo de la sección guardada.
const put = vi.fn(async (_p: string, _b: unknown) => ({
  success: true,
  data: {
    doc: { id: "d1", orgId: "o1", stale: false },
    tabs: [
      { id: "t1", docId: "d1", key: "overview", body: "nuevo", bodyHash: "hash-nuevo" },
      { id: "t2", docId: "d1", key: "runbook", body: "otro", bodyHash: "hash-otro" },
    ],
    decisions: [],
    attachments: [],
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn(async () => ({ success: true, data: {} })),
    put: (p: string, b: unknown) => put(p, b),
    patch: (p: string, b: unknown) => patch(p, b),
    delete: vi.fn(async () => ({ success: true, data: {} })),
  },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ session: { id: "yo" } }), subscribe: vi.fn() },
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: { getState: () => ({ currentOrgId: "o1" }), subscribe: vi.fn() },
}));
vi.mock("@/store/mywork.store", () => ({
  useMyWorkStore: { getState: () => ({ refresh: vi.fn() }), subscribe: vi.fn() },
}));

const { useTasksStore } = await import("@/store/tasks.store");

const conDocumento = () =>
  useTasksStore.setState({
    activeDoc: { kind: "list", id: "l1", name: "Portento" },
    doc: {
      doc: {
        id: "d1",
        orgId: "o1",
        ownerKind: "list",
        ownerId: "l1",
        body: "",
        updatedBy: "yo",
        createdAt: "",
        updatedAt: "",
        stale: true,
      },
      tabs: [
        { id: "t1", docId: "d1", key: "overview", body: "# Lo escrito", updatedBy: "yo", updatedAt: "" },
        { id: "t2", docId: "d1", key: "runbook", body: "1. Parar", updatedBy: "yo", updatedAt: "" },
      ],
      decisions: [],
      attachments: [],
    },
  });

beforeEach(() => {
  patch.mockClear();
  get.mockClear();
  put.mockClear();
  conDocumento();
});

/**
 * Guardar devuelve el hash de lo que acaba de quedar.
 *
 * Quien está escribiendo no relee el documento —adoptarlo encima de un borrador
 * es justo lo que no puede pasar— así que si el hash no vuelve por aquí, el
 * siguiente guardado manda el de antes y el servidor lo rechaza por chocar con
 * la escritura anterior de esa misma persona. Deja de guardarse todo, a la
 * segunda vez.
 */
describe("saveDoc", () => {
  it("devuelve el hash de la sección que se guardó, no el de otra", async () => {
    expect(await useTasksStore.getState().saveDoc("nuevo", "overview", "hash-viejo")).toBe(
      "hash-nuevo",
    );
    // La segunda, y a propósito: con una sola sección, coger «la primera» de la
    // respuesta acierta por casualidad y la prueba pasaría con el error dentro.
    expect(await useTasksStore.getState().saveDoc("otro", "runbook", "hash-viejo")).toBe(
      "hash-otro",
    );
  });

  it("manda el hash que se le dio", async () => {
    await useTasksStore.getState().saveDoc("nuevo", "runbook", "hash-viejo");
    expect(put).toHaveBeenCalledWith("/api/v1/docs/list/l1/tabs/runbook", {
      body: "nuevo",
      baseHash: "hash-viejo",
    });
  });

  // Una sección que nunca se guardó no tiene hash, y mandar uno vacío haría que
  // el servidor lo comparase contra nada.
  it("sin hash no manda el campo", async () => {
    await useTasksStore.getState().saveDoc("nuevo", "overview");
    expect(put).toHaveBeenCalledWith("/api/v1/docs/list/l1/tabs/overview", { body: "nuevo" });
  });
});

describe("patchDoc", () => {
  it("las pestañas siguen ahí después de cambiar el responsable", async () => {
    await useTasksStore.getState().patchDoc({ maintainerId: "u9" });
    const tabs = useTasksStore.getState().doc?.tabs ?? [];
    expect(tabs.map((x) => x.body)).toEqual(["# Lo escrito", "1. Parar"]);
    expect(useTasksStore.getState().doc?.doc?.maintainerId).toBe("u9");
  });

  // El servidor pone la fecha, no el cliente: dejar que la ponga quien llama le
  // deja mentir sobre la frescura, y que el dato sea cierto es todo su valor.
  it("marcar revisado manda un booleano, nunca una fecha", async () => {
    await useTasksStore.getState().patchDoc({ reviewed: true });
    expect(patch).toHaveBeenCalledWith("/api/v1/docs/list/l1", { reviewed: true });
  });

  it("sin documento abierto no llama al servidor", async () => {
    useTasksStore.setState({ activeDoc: null });
    await useTasksStore.getState().patchDoc({ reviewed: true });
    expect(patch).not.toHaveBeenCalled();
  });

  // El navegador pinta la línea fijada sobre el tablero, y sale del índice: sin
  // volver a pedirlo, la línea que acabas de escribir no aparece hasta recargar.
  it("refresca el índice, que es de donde sale el banner", async () => {
    await useTasksStore.getState().patchDoc({ pinnedLine: "Ojo con el host nuevo" });
    expect(get).toHaveBeenCalledWith(expect.stringContaining("/api/v1/docs/?orgId="));
  });
});
