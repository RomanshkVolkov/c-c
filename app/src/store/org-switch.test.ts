import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cambiar de organización cierra lo que es de la otra, y sólo eso.
 *
 * El reporte (jose, 29-sep): cambiar de org y volver enseñaba abierto un
 * directo de otra org. El único cierre vivía en `DMSwitcher`, que sólo existe
 * en `/dm`, así que un cambio hecho desde cualquier otra pantalla no lo veía
 * nadie. Aquí se prueba el sitio único, sin montar ninguna pantalla: el cambio
 * puede venir de donde sea.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));

const { alCambiarDeOrg, installOrgSwitch } = await import("./org-switch");
const { useDMStore } = await import("./dm.store");
const { useTasksStore } = await import("./tasks.store");
const { useOrgsStore } = await import("./orgs.store");

const tarea = (orgId: string) =>
  ({ task: { id: "t-1", orgId } }) as unknown as NonNullable<ReturnType<typeof useTasksStore.getState>["detail"]>;

beforeEach(() => {
  useDMStore.setState({ conversationId: null, conversationOrgId: null, messages: [] });
  useTasksStore.setState({ openTaskId: null, detail: null, activeDoc: null, doc: null });
});

describe("al cambiar de organización", () => {
  it("se cierra el directo de la org que dejas, aunque `/dm` no esté montado", () => {
    useDMStore.setState({ conversationId: "c-1", conversationOrgId: "org-a" });
    alCambiarDeOrg("org-a", "org-b");
    expect(useDMStore.getState().conversationId).toBeNull();
  });

  it("no se cierra el directo de la org a la que vas", () => {
    // El caso del enlace: se abre el directo y se cambia a su org.
    useDMStore.setState({ conversationId: "c-1", conversationOrgId: "org-b" });
    alCambiarDeOrg("org-a", "org-b");
    expect(useDMStore.getState().conversationId).toBe("c-1");
  });

  it("se cierra la tarea de la otra org y se queda la de ésta", () => {
    useTasksStore.setState({ openTaskId: "t-1", detail: tarea("org-a") });
    alCambiarDeOrg("org-a", "org-b");
    expect(useTasksStore.getState().openTaskId).toBeNull();

    useTasksStore.setState({ openTaskId: "t-1", detail: tarea("org-b") });
    alCambiarDeOrg("org-a", "org-b");
    expect(useTasksStore.getState().openTaskId).toBe("t-1");
  });

  it("se cierra el documento de la otra org y se queda el de ésta", () => {
    useTasksStore.setState({ activeDoc: { kind: "list", id: "l-1", name: "x", orgId: "org-a" } });
    alCambiarDeOrg("org-a", "org-b");
    expect(useTasksStore.getState().activeDoc).toBeNull();

    useTasksStore.setState({ activeDoc: { kind: "list", id: "l-1", name: "x", orgId: "org-b" } });
    alCambiarDeOrg("org-a", "org-b");
    expect(useTasksStore.getState().activeDoc?.id).toBe("l-1");
  });

  it("se entera de cualquier cambio de org, no sólo del selector", () => {
    installOrgSwitch();
    useOrgsStore.setState({ currentOrgId: "org-a" });
    useDMStore.setState({ conversationId: "c-1", conversationOrgId: "org-a" });
    // Como lo haría `fetchOrgs` al sacarte de una org que ya no es tuya.
    useOrgsStore.setState({ currentOrgId: "org-b" });
    expect(useDMStore.getState().conversationId).toBeNull();
  });
});

describe("abrir un directo lo sella con su org", () => {
  it("la de la lista de conversaciones, si no se dice", async () => {
    useDMStore.setState({
      conversations: [{ conversationId: "c-9", orgId: "org-a", userId: "u", username: "u", unread: 0 }],
    });
    await useDMStore.getState().open("c-9");
    expect(useDMStore.getState().conversationOrgId).toBe("org-a");
  });

  it("la que se le da, si se dice", async () => {
    useDMStore.setState({ conversations: [] });
    await useDMStore.getState().open("c-9", "org-b");
    expect(useDMStore.getState().conversationOrgId).toBe("org-b");
  });
});

describe("un documento guardado de antes", () => {
  it("sin su org, no se rehidrata: no se sabe de quién es", async () => {
    localStorage.setItem(
      "cac-tasks",
      JSON.stringify({ state: { activeDoc: { kind: "list", id: "l-viejo", name: "x" } }, version: 0 }),
    );
    await useTasksStore.persist.rehydrate();
    expect(useTasksStore.getState().activeDoc).toBeNull();

    localStorage.setItem(
      "cac-tasks",
      JSON.stringify({ state: { activeDoc: { kind: "list", id: "l-1", name: "x", orgId: "org-a" } }, version: 0 }),
    );
    await useTasksStore.persist.rehydrate();
    expect(useTasksStore.getState().activeDoc?.id).toBe("l-1");
  });
});
