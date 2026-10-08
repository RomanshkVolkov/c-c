import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Una página abierta: el mismo autoguardado que la portada, con las mismas dos
 * trampas, y lo que la hace página —de dónde cuelga y qué tiene dentro—.
 *
 * - El hash avanza con cada guardado. Si no, el segundo autoguardado choca con
 *   el primero y desde ahí no se guarda nada (ver `DocTabs.hash.test.tsx`).
 * - Un guardado que choca para el autoguardado y lo dice. Seguir mandando
 *   pisaría lo que escribió otro —una persona, o un agente por MCP—.
 */

const put = vi.fn();
const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (p: string) => get(p), post: vi.fn(), put: (p: string, b: unknown) => put(p, b), delete: vi.fn() },
  apiUrl: (p: string) => p,
  codigoDe: (e: { code?: string } | null) => e?.code ?? "",
}));
vi.mock("@/components/markdown/MarkdownEditor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("@/components/markdown/Markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("@/components/docs/DocToc", () => ({ default: () => null }));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ uploadDocAttachment: vi.fn() }),
}));

const { default: DocPageView } = await import("@/components/docs/DocPageView");
const { useDocPages } = await import("@/store/doc-pages.store");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

const pagina = (body: string, bodyHash: string) => ({
  id: "p2",
  docId: "d1",
  orgId: "o1",
  title: "Nereus",
  rank: "0.5",
  body,
  bodyHash,
  updatedBy: "u1",
  createdAt: "",
  updatedAt: "",
});

beforeEach(() => {
  vi.useFakeTimers();
  put.mockReset();
  get.mockReset();
  useDocPages.setState({
    owner: { kind: "list", id: "l1" },
    activePageId: "p2",
    loadingPage: false,
    tree: [],
    view: {
      page: pagina("lo que había", "hash-0"),
      breadcrumb: [{ id: "p1", title: "Apps" }],
      children: [{ id: "p3", title: "Despliegue", rank: "0.5", hasBody: true, updatedAt: "" }],
      orgId: "o1",
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const montar = () =>
  render(
    <ConfirmProvider>
      <DocPageView kind="list" ownerId="l1" nodeName="Proteus" />
    </ConfirmProvider>,
  );

const escribir = async (texto: string) => {
  fireEvent.change(screen.getByLabelText("editor"), { target: { value: texto } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
};

describe("una página abierta", () => {
  it("el segundo guardado va con el hash que devolvió el primero", async () => {
    let n = 0;
    put.mockImplementation(async (_p: string, b: { body: string }) => ({
      data: pagina(b.body, `hash-${++n}`),
    }));
    montar();
    fireEvent.click(screen.getByText("Edit"));
    await escribir("uno");
    await escribir("uno y dos");
    expect(put.mock.calls.map((c) => c[1])).toEqual([
      { body: "uno", baseHash: "hash-0" },
      { body: "uno y dos", baseHash: "hash-1" },
    ]);
    expect(put.mock.calls[0][0]).toBe("/api/v1/docs/list/l1/pages/p2");
  });

  it("si alguien guardó antes, lo dice y deja de guardar", async () => {
    put.mockRejectedValue(Object.assign(new Error("conflict"), { code: "doc-page-conflict" }));
    montar();
    fireEvent.click(screen.getByText("Edit"));
    await escribir("lo mío");
    expect(screen.getByText(/someone else got there first/i)).toBeTruthy();
    await escribir("lo mío y más");
    expect(put).toHaveBeenCalledTimes(1);
    // El borrador se queda: lo escrito no se pierde por chocar.
    expect((screen.getByLabelText("editor") as HTMLTextAreaElement).value).toBe("lo mío y más");
  });

  it("dice de dónde cuelga, y la portada cierra la página", () => {
    montar();
    expect(screen.getByText("Apps")).toBeTruthy();
    fireEvent.click(screen.getByText("Proteus"));
    expect(useDocPages.getState().activePageId).toBeNull();
  });

  it("enseña lo que tiene dentro, y lo abre", () => {
    get.mockResolvedValue({ data: null });
    montar();
    fireEvent.click(screen.getByText("Despliegue"));
    expect(useDocPages.getState().activePageId).toBe("p3");
    expect(get).toHaveBeenCalledWith("/api/v1/docs/list/l1/pages/p3");
  });
});
