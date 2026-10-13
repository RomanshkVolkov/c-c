import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

/**
 * Las páginas de un documento, en el teléfono.
 *
 * En el escritorio viven en el panel de Documentación; en el teléfono no hay
 * panel, así que la cabecera lleva un botón «Páginas» que abre una hoja con la
 * portada y las páginas. En el escritorio el botón no está: sería la segunda
 * puerta a lo mismo. Y el documento ya no lleva su columna de páginas al lado.
 * Mutantes: sin la condición del móvil; no cerrar la hoja al elegir.
 */

// El documento pide su árbol al montarse (`enter`): contesta con la página.
const PAGES = [{ id: "p1", title: "Entrega", rank: "0.5", hasBody: false, updatedAt: "" }];
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async (u: string) => ({ data: u.endsWith("/pages") ? PAGES : null })),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiUrl: (p: string) => p,
  codigoDe: () => "",
}));
vi.mock("@/components/markdown/Markdown", () => ({ default: ({ children }: { children: string }) => <p>{children}</p> }));
vi.mock("@/components/docs/DocHeader", () => ({ default: () => null }));
vi.mock("@/components/docs/DocHistory", () => ({ default: () => null }));
vi.mock("@/components/docs/ShareDoc", () => ({ default: () => null }));
vi.mock("@/components/docs/DocToc", () => ({ default: () => null }));
vi.mock("@/components/docs/DocPageView", () => ({ default: () => <p>leyendo la página</p> }));
vi.mock("@/components/CopyId", () => ({ default: () => null }));
vi.mock("@/components/tasks/ViewSwitch", () => ({ default: () => null }));

const state = {
  activeDoc: { kind: "list", id: "l1", name: "Portento", orgId: "o1" },
  doc: {
    doc: { id: "d1", orgId: "o1", stale: false },
    tabs: [{ id: "t1", docId: "d1", key: "overview", body: "la portada", bodyHash: "h" }],
    decisions: [],
    attachments: [],
  },
  loadingDoc: false,
  saveDoc: vi.fn(),
  uploadDocAttachment: vi.fn(),
  closeDoc: vi.fn(),
  openDoc: vi.fn(),
  addDecision: vi.fn(),
};
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: Object.assign((sel: (s: Record<string, unknown>) => unknown) => sel(state), {
    getState: () => state,
  }),
}));

const { default: DocTabs } = await import("@/components/docs/DocTabs");
const { useDocPages } = await import("@/store/doc-pages.store");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { PromptProvider } = await import("@/components/PromptDialog");

const mount = () =>
  render(
    <ConfirmProvider>
      <PromptProvider>
        <DocTabs onView={() => {}} />
      </PromptProvider>
    </ConfirmProvider>,
  );

let width = 390;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => width });
  useDocPages.setState({
    owner: { kind: "list", id: "l1" },
    tree: PAGES,
    activePageId: null,
    view: null,
    pagesByOwner: {},
  });
});
afterEach(cleanup);

describe("las páginas en el teléfono", () => {
  it("un botón en la cabecera abre la portada y las páginas", async () => {
    width = 390;
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Home")).toBeTruthy();
    expect(within(sheet).getByText("Entrega")).toBeTruthy();
  });

  it("elegir una página la abre y cierra la hoja", async () => {
    width = 390;
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("Entrega"));
    expect(useDocPages.getState().activePageId).toBe("p1");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("en el escritorio no hay botón, ni columna de páginas al lado", () => {
    width = 1280;
    mount();
    expect(screen.queryByRole("button", { name: "Pages" })).toBeNull();
    expect(screen.queryByText("Entrega")).toBeNull();
    expect(screen.getByText("la portada")).toBeTruthy();
  });
});
