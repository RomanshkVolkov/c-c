import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Un enlace de dentro, escrito en un documento, se abre dentro.
 *
 * La portada pintaba su markdown sin `onInternalLink`, así que un enlace a otro
 * documento —lo primero que se escribe en una wiki— se iba al navegador del
 * sistema con una URL que fuera de la app no abre nada. Lo mismo una página.
 */

const abrirDentro = vi.fn((_href: string) => true);
vi.mock("@/lib/open-ref", () => ({ openInternalRef: (h: string) => abrirDentro(h) }));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
  codigoDe: () => "",
}));
// El Markdown de verdad decide qué es interno; aquí basta con que se le pase
// quién lo abre, y con pulsarlo.
vi.mock("@/components/markdown/Markdown", () => ({
  default: ({ children, onInternalLink }: { children: string; onInternalLink?: (h: string) => boolean }) => (
    <button onClick={() => onInternalLink?.("/tasks?doc=list:l2&page=p1")}>{children}</button>
  ),
}));
vi.mock("@/components/docs/DocHeader", () => ({ default: () => null }));
vi.mock("@/components/docs/DocHistory", () => ({ default: () => null }));
vi.mock("@/components/docs/ShareDoc", () => ({ default: () => null }));
vi.mock("@/components/docs/DocToc", () => ({ default: () => null }));
vi.mock("@/components/CopyId", () => ({ default: () => null }));
vi.mock("@/components/tasks/ViewSwitch", () => ({ default: () => null }));

const estado = {
  activeDoc: { kind: "list", id: "l1", name: "Portento", orgId: "o1" },
  doc: {
    doc: { id: "d1", orgId: "o1", stale: false },
    tabs: [
      { id: "t1", docId: "d1", key: "overview", body: "ver la otra", bodyHash: "h" },
      { id: "t2", docId: "d1", key: "runbook", body: "el runbook", bodyHash: "h2" },
    ],
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
  useTasksStore: Object.assign((sel: (s: Record<string, unknown>) => unknown) => sel(estado), {
    getState: () => estado,
  }),
}));

const DocTabs = (await import("@/components/docs/DocTabs")).default;

afterEach(cleanup);

describe("un enlace dentro de la portada", () => {
  it("se abre dentro de la app", () => {
    render(<DocTabs onView={() => {}} />);
    fireEvent.click(screen.getByText("ver la otra"));
    expect(abrirDentro).toHaveBeenCalledWith("/tasks?doc=list:l2&page=p1");
  });
});

describe("la pestaña que pide un enlace", () => {
  it("la portada se abre en ella", async () => {
    const { useDocPages } = await import("@/store/doc-pages.store");
    useDocPages.getState().requestTab("runbook");
    render(<DocTabs onView={() => {}} />);
    expect(screen.getByText("el runbook")).toBeTruthy();
    expect(useDocPages.getState().requestedTab).toBeNull();
  });
});

// Lo mismo en la portada: el índice busca esta marca (ver `DocToc`).
describe("lo que hace scroll en la portada", () => {
  it("lleva la marca que busca el índice, y es lo que tiene el texto", () => {
    render(<DocTabs onView={() => {}} />);
    const scroller = document.querySelector("[data-doc-scroll]");
    expect(scroller?.classList.contains("overflow-auto")).toBe(true);
    expect(scroller?.textContent).toContain("ver la otra");
  });
});
