import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Cambiar de pestaña no puede escribir una encima de otra.
 *
 * Con autoguardado, apagar el editor fuerza un guardado de lo que quedaba. Al
 * cambiar de sección las dos cosas ocurren a la vez, y por un render el texto
 * es el de la sección vieja mientras la activa ya es la nueva. Guardar en ese
 * instante escribe el resumen encima del runbook: se pierde el runbook entero y
 * nadie se entera hasta que va a leerlo.
 *
 * Es el fallo característico de esta clase de código y no se ve mirándolo.
 */

const saveDoc = vi.fn(async () => {});

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
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
    tabs: [
      { id: "t1", docId: "d1", key: "overview", body: "el resumen" },
      { id: "t2", docId: "d1", key: "runbook", body: "el runbook" },
    ],
    attachments: [],
  },
  loadingDoc: false,
  saveDoc,
  uploadDocAttachment: vi.fn(),
  closeDoc: vi.fn(),
  board: null,
  docVersions: vi.fn(async () => []),
  restoreDoc: vi.fn(),
};

vi.mock("@/store/tasks.store", () => ({
  useTasksStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel(estado),
    { getState: () => estado },
  ),
}));

const DocTabs = (await import("@/components/docs/DocTabs")).default;

afterEach(() => {
  cleanup();
  saveDoc.mockClear();
});

describe("cambiar de sección con algo escrito", () => {
  it("lo pendiente se guarda en la sección en la que se escribió", async () => {
    render(<DocTabs onView={() => {}} />);

    // Editar el resumen y escribir sin esperar a que el temporizador dispare.
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("editor"), {
      target: { value: "el resumen, corregido" },
    });

    // Y saltar a otra pestaña de inmediato, que es lo que hace cualquiera.
    fireEvent.click(screen.getByText("Runbook"));

    await waitFor(() => expect(saveDoc).toHaveBeenCalled());
    expect(saveDoc).toHaveBeenCalledWith("el resumen, corregido", "overview");
    // Y desde luego no en la que se acaba de abrir.
    expect(saveDoc).not.toHaveBeenCalledWith(expect.anything(), "runbook");
  });
});
