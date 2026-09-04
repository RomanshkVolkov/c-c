import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El hash tiene que avanzar con cada guardado.
 *
 * El servidor rechaza un guardado que trae el hash de una versión anterior — es
 * lo que impide borrar lo que otro escribió. Pero el editor no relee el
 * documento mientras se escribe (adoptarlo encima de un borrador es justo lo que
 * no puede pasar), así que si el hash no se actualiza al guardar, **el segundo
 * autoguardado choca contra su propia escritura** y a partir de ahí no se guarda
 * nada más. Es un fallo que sólo aparece a la segunda vez.
 */

const guardados: [string, string, string | undefined][] = [];
const saveDoc = vi.fn(async (body: string, tab: string, baseHash?: string) => {
  guardados.push([body, tab, baseHash]);
  return `hash-${guardados.length}`;
});

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
  codigoDe: () => "",
}));
vi.mock("@/components/markdown/MarkdownEditor", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock("@/components/markdown/Markdown", () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("@/components/docs/DocHeader", () => ({ default: () => null }));
vi.mock("@/components/docs/DocHistory", () => ({ default: () => null }));
vi.mock("@/components/docs/ShareDoc", () => ({ default: () => null }));
vi.mock("@/components/docs/DocToc", () => ({ default: () => null }));
vi.mock("@/components/CopyId", () => ({ default: () => null }));
vi.mock("@/components/tasks/ViewSwitch", () => ({ default: () => null }));

const estado = {
  activeDoc: { kind: "list", id: "l1", name: "Portento" },
  doc: {
    doc: { id: "d1", orgId: "o1", stale: false },
    tabs: [{ id: "t1", docId: "d1", key: "overview", body: "lo que había", bodyHash: "hash-0" }],
    decisions: [],
    attachments: [],
  },
  loadingDoc: false,
  saveDoc,
  uploadDocAttachment: vi.fn(),
  closeDoc: vi.fn(),
  openDoc: vi.fn(),
  board: null,
  docVersions: vi.fn(async () => []),
  restoreDoc: vi.fn(),
  addDecision: vi.fn(),
};

vi.mock("@/store/tasks.store", () => ({
  useTasksStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel(estado),
    { getState: () => estado },
  ),
}));

const DocTabs = (await import("@/components/docs/DocTabs")).default;

beforeEach(() => {
  vi.useFakeTimers();
  guardados.length = 0;
  saveDoc.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("el hash del borrador", () => {
  it("el segundo guardado va con el hash que devolvió el primero", async () => {
    render(<DocTabs onView={() => {}} />);
    fireEvent.click(screen.getByText("Edit"));

    fireEvent.change(screen.getByLabelText("editor"), { target: { value: "uno" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(guardados[0]).toEqual(["uno", "overview", "hash-0"]);

    fireEvent.change(screen.getByLabelText("editor"), { target: { value: "uno y dos" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(guardados).toHaveLength(2);
    // Y no "hash-0" otra vez, que es lo que el servidor rechazaría.
    expect(guardados[1]).toEqual(["uno y dos", "overview", "hash-1"]);
  });
});
