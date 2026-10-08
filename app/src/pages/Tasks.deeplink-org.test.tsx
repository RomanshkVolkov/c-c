import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Un enlace a una tarea de otra org te lleva a esa org, con la tarea abierta.
 *
 * `?task=` sólo lleva el id, y la org se sabe al cargar la tarea. Antes se
 * abría en la org en pantalla —la de otro cliente—; ahora se carga, se mira de
 * quién es y se cambia a la suya. Y el cajón sobrevive al cambio porque lleva
 * el sello de su org: `org-switch` sólo cierra lo que es de otra.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/components/ItemCalendar", () => ({ default: () => null }));

const { default: Tasks } = await import("./Tasks");
const { useTasksStore } = await import("@/store/tasks.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { installOrgSwitch } = await import("@/store/org-switch");
const { usePlacesStore } = await import("@/store/places.store");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

const detalle = {
  task: { id: "t-1", orgId: "org-a", listId: "li-a", title: "De la otra", statusId: "s", seq: 1 },
  status: { id: "s", name: "Open", kind: "open" },
  tags: [], assignees: [], comments: [], attachments: [], subtasks: [], backlinks: [],
};

beforeEach(() => {
  installOrgSwitch();
  api.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/tasks/t-1")) return { success: true, data: detalle };
    if (url.startsWith("/api/v1/docs/space/sp-a"))
      return { success: true, data: { doc: null, tabs: [], decisions: [], attachments: [], orgId: "org-a" } };
    return { success: true, data: [] };
  });
  useOrgsStore.setState({
    orgs: [
      { id: "org-a", name: "A" },
      { id: "org-b", name: "B" },
    ],
    currentOrgId: "org-b",
  } as never);
  useTasksStore.setState({ openTaskId: null, detail: null, activeDoc: null });
});
afterEach(cleanup);

describe("?task= de otra org", () => {
  it("termina en la org de la tarea, con la tarea abierta", async () => {
    render(
      <ConfirmProvider>
        <PromptProvider>
          <MemoryRouter initialEntries={["/tasks?task=t-1"]}>
            <Tasks />
          </MemoryRouter>
        </PromptProvider>
      </ConfirmProvider>,
    );
    await waitFor(() => expect(useOrgsStore.getState().currentOrgId).toBe("org-a"));
    expect(useTasksStore.getState().openTaskId).toBe("t-1");
  });

  it("aunque la org de la tarea recordara un documento: la tarea es la que te trajo", async () => {
    usePlacesStore.getState().remember("org-a", { doc: { kind: "space", id: "sp-a", name: "Doc de A" } });
    render(
      <ConfirmProvider>
        <PromptProvider>
          <MemoryRouter initialEntries={["/tasks?task=t-1"]}>
            <Tasks />
          </MemoryRouter>
        </PromptProvider>
      </ConfirmProvider>,
    );
    await waitFor(() => expect(useOrgsStore.getState().currentOrgId).toBe("org-a"));
    await new Promise((r) => setTimeout(r, 0));
    expect(useTasksStore.getState().openTaskId).toBe("t-1");
    usePlacesStore.setState({ byOrg: {} });
  });
});

describe("?doc= de otra org", () => {
  it("termina en la org del documento, con el documento abierto", async () => {
    render(
      <ConfirmProvider>
        <PromptProvider>
          <MemoryRouter initialEntries={["/tasks?doc=space:sp-a"]}>
            <Tasks />
          </MemoryRouter>
        </PromptProvider>
      </ConfirmProvider>,
    );
    await waitFor(() => expect(useOrgsStore.getState().currentOrgId).toBe("org-a"));
    expect(useTasksStore.getState().activeDoc?.id).toBe("sp-a");
  });
});

/**
 * `&page=` va en el mismo enlace que `?doc=`, y el efecto vacía los parámetros
 * en cuanto lee `doc`. Si la página se leyera después —en otro efecto, o tras
 * vaciar—, el enlace abriría la portada y nadie sabría por qué.
 */
describe("?doc=…&page=", () => {
  it("abre el documento y, dentro, la página", async () => {
    const { useDocPages } = await import("@/store/doc-pages.store");
    useDocPages.getState().reset();
    render(
      <ConfirmProvider>
        <PromptProvider>
          <MemoryRouter initialEntries={["/tasks?doc=space:sp-a&page=p-7"]}>
            <Tasks />
          </MemoryRouter>
        </PromptProvider>
      </ConfirmProvider>,
    );
    await waitFor(() => expect(useTasksStore.getState().activeDoc?.id).toBe("sp-a"));
    expect(useDocPages.getState().activePageId).toBe("p-7");
    expect(api.get).toHaveBeenCalledWith("/api/v1/docs/space/sp-a/pages/p-7");
  });
});
