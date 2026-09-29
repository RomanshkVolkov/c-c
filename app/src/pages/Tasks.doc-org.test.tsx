import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * El documento abierto de otra org no se pinta en ésta.
 *
 * `activeDoc` está persistido, y sobrevivía a cambiar de org y a cerrar la app:
 * se veía la documentación de otra org dentro de ésta. Lo cierra
 * `store/org-switch.ts`; esto es lo que garantiza que no se vea aunque siga ahí.
 * Y abrir un doc se queda con la org que dice el servidor, que es la que vale
 * cuando se llega por un enlace desde otra.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/components/docs/DocTabs", () => ({ default: () => <p>el documento</p> }));
vi.mock("@/components/ItemCalendar", () => ({ default: () => null }));

const { default: Tasks } = await import("./Tasks");
const { useTasksStore } = await import("@/store/tasks.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

beforeEach(() => {
  api.get.mockResolvedValue({ success: true, data: [] });
  useOrgsStore.setState({ currentOrgId: "org-b" });
});
afterEach(cleanup);

const pantalla = () =>
  render(
    <ConfirmProvider>
      <PromptProvider>
        <MemoryRouter initialEntries={["/tasks"]}>
          <Tasks />
        </MemoryRouter>
      </PromptProvider>
    </ConfirmProvider>,
  );

describe("el documento abierto y la org en pantalla", () => {
  it("uno de otra org no se pinta", () => {
    useTasksStore.setState({ activeDoc: { kind: "space", id: "sp-1", name: "x", orgId: "org-a" } });
    pantalla();
    expect(screen.queryByText("el documento")).toBeNull();
  });

  it("uno de esta org, sí", () => {
    useTasksStore.setState({ activeDoc: { kind: "space", id: "sp-1", name: "x", orgId: "org-b" } });
    pantalla();
    expect(screen.getByText("el documento")).toBeTruthy();
  });
});

describe("abrir un documento", () => {
  it("se queda con la org que dice el servidor, no con la de la pantalla", async () => {
    api.get.mockResolvedValue({
      success: true,
      data: { doc: null, tabs: [], decisions: [], attachments: [], orgId: "org-a" },
    });
    await useTasksStore.getState().openDoc("space", "sp-9", "De la otra");
    expect(useTasksStore.getState().activeDoc?.orgId).toBe("org-a");
  });

  it("sin org en la respuesta, la de la pantalla", async () => {
    api.get.mockResolvedValue({ success: true, data: { doc: null, tabs: [], decisions: [], attachments: [] } });
    await useTasksStore.getState().openDoc("space", "sp-1", "De aquí");
    expect(useTasksStore.getState().activeDoc?.orgId).toBe("org-b");
  });
});
