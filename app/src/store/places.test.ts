import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cada org recuerda dónde estabas (pedido por jose, 29-sep).
 *
 * Lo delicado no es apuntar sino **cuándo borrar**: al cambiar de org,
 * `org-switch` cierra lo de la anterior, y eso no es «ya no quiero volver
 * ahí». Si se borrase, volver a A no restauraría nada, que es justo el fallo
 * que se pidió arreglar.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => p }));

const { installOrgSwitch } = await import("./org-switch");
const { installPlaces } = await import("./places");
const { usePlacesStore, placeOf } = await import("./places.store");
const { useOrgsStore } = await import("./orgs.store");
const { useTasksStore } = await import("./tasks.store");
const { useDMStore } = await import("./dm.store");
const { useAuthStore } = await import("./auth.store");

installOrgSwitch();
installPlaces();

/** El documento contesta con la org que se le diga; lo demás, vacío. */
let orgDelDoc = "org-a";
const hasta = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  api.get.mockImplementation(async (url: string) =>
    url.startsWith("/api/v1/docs/")
      ? { success: true, data: { doc: null, tabs: [], decisions: [], attachments: [], orgId: orgDelDoc } }
      : { success: true, data: [] },
  );
  useOrgsStore.setState({
    orgs: [
      { id: "org-a", name: "A" },
      { id: "org-b", name: "B" },
    ],
    currentOrgId: "org-a",
  } as never);
  useTasksStore.setState({ activeListId: null, activeDoc: null, doc: null, openTaskId: null, detail: null });
  useDMStore.setState({ conversationId: null, conversationOrgId: null, conversations: [] });
  usePlacesStore.setState({ byOrg: {} });
  orgDelDoc = "org-a";
});

describe("volver a una org", () => {
  it("de A a B y de vuelta a A, están la lista y el documento de A", async () => {
    await useTasksStore.getState().selectList("li-a");
    await useTasksStore.getState().openDoc("space", "sp-a", "Doc de A");
    expect(placeOf("org-a")).toMatchObject({ listId: "li-a", doc: { id: "sp-a" } });

    useOrgsStore.setState({ currentOrgId: "org-b" });
    await hasta();
    // En B no queda nada de A.
    expect(useTasksStore.getState().activeDoc).toBeNull();
    expect(useTasksStore.getState().activeListId).toBeNull();
    await useTasksStore.getState().selectList("li-b");

    useOrgsStore.setState({ currentOrgId: "org-a" });
    await hasta();
    expect(useTasksStore.getState().activeListId).toBe("li-a");
    expect(useTasksStore.getState().activeDoc).toMatchObject({ id: "sp-a", orgId: "org-a" });
    // Y B se acuerda de lo suyo para la vuelta.
    expect(placeOf("org-b").listId).toBe("li-b");
  });

  it("cerrar el documento de A al irte a B no toca el que B recordaba", async () => {
    // B tenía el suyo apuntado; en A hay otro abierto.
    usePlacesStore.getState().remember("org-b", { doc: { kind: "space", id: "sp-b", name: "Doc de B" } });
    await useTasksStore.getState().openDoc("space", "sp-a", "Doc de A");

    orgDelDoc = "org-b";
    useOrgsStore.setState({ currentOrgId: "org-b" });
    await hasta();
    expect(useTasksStore.getState().activeDoc).toMatchObject({ id: "sp-b", orgId: "org-b" });
  });

  it("un documento de otra org abierto por un enlace se apunta en la suya, no en ésta", async () => {
    useOrgsStore.setState({ currentOrgId: "org-b" });
    orgDelDoc = "org-a";
    await useTasksStore.getState().openDoc("space", "sp-a", "Doc de A");
    expect(placeOf("org-b").doc).toBeUndefined();
    expect(placeOf("org-a").doc?.id).toBe("sp-a");
  });

  it("cerrar al cambiar de org no olvida; cerrar a propósito, sí", async () => {
    useDMStore.setState({ conversations: [{ conversationId: "c-1", orgId: "org-a", userId: "u", username: "u", unread: 0 }] });
    await useDMStore.getState().open("c-1");
    expect(placeOf("org-a").dm).toBe("c-1");

    useOrgsStore.setState({ currentOrgId: "org-b" });
    expect(useDMStore.getState().conversationId).toBeNull();
    expect(placeOf("org-a").dm).toBe("c-1");

    useOrgsStore.setState({ currentOrgId: "org-a" });
    await useDMStore.getState().open("c-1");
    useDMStore.getState().close();
    expect(placeOf("org-a").dm).toBeUndefined();
  });

  it("un documento cerrado a propósito se olvida", async () => {
    await useTasksStore.getState().openDoc("space", "sp-a", "Doc de A");
    useTasksStore.getState().closeDoc();
    expect(placeOf("org-a").doc).toBeUndefined();
  });
});

describe("lo apuntado", () => {
  it("sobrevive a cerrar la app", async () => {
    localStorage.setItem("cac-places", JSON.stringify({ state: { byOrg: { "org-a": { listId: "li-a" } } }, version: 0 }));
    await usePlacesStore.persist.rehydrate();
    expect(placeOf("org-a").listId).toBe("li-a");
  });

  it("se borra al cerrar sesión: otra persona no hereda dónde estabas tú", () => {
    usePlacesStore.getState().remember("org-a", { listId: "li-a" });
    useAuthStore.setState({ accessToken: "t" } as never);
    useAuthStore.setState({ accessToken: null } as never);
    expect(usePlacesStore.getState().byOrg).toEqual({});
  });
});
