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

vi.mock("@/lib/api", () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn(async () => ({ success: true, data: {} })),
    put: vi.fn(async () => ({ success: true, data: {} })),
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
      attachments: [],
    },
  });

beforeEach(() => {
  patch.mockClear();
  get.mockClear();
  conDocumento();
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
