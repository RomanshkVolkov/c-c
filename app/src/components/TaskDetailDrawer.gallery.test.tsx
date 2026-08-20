import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

/**
 * Una captura de cliente se ve, no se lista.
 *
 * En un reporte que llega por la integración, la captura **es** el reporte. Y
 * salía como una línea con un clip que había que abrir en otro programa, una
 * por una — la app ya sabía pintar una imagen autenticada con zoom, pero sólo
 * dentro del cuerpo en markdown, y lo que manda un cliente entra como adjunto
 * de galería.
 */

const { estado } = vi.hoisted(() => ({ estado: { current: {} as Record<string, unknown> } }));

/**
 * `contentType` opcional **de verdad**: cuando no se pasa, la clave no existe.
 *
 * La primera versión de este test le ponía `""`, y eso fue lo que dejó pasar el
 * fallo: `"".startsWith` funciona y `undefined.startsWith` tumba la pantalla.
 * El servidor manda el campo con `omitempty`, así que lo que llega de verdad es
 * la ausencia, no el vacío.
 */
const adjunto = (id: string, fileName: string, contentType?: string) => ({
  id, taskId: "t-1", url: `/api/v1/tasks/t-1/attachments/${id}/raw`,
  fileName, bytes: 4096,
  ...(contentType === undefined ? {} : { contentType }),
});

const detalle = {
  task: {
    id: "t-1", seq: 100, title: "Error de cálculo", description: "", priority: "normal",
    status: "pending", listId: "li-1", orgId: "o-1", projectId: "p-1", visibility: "public",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  attachments: [
    adjunto("a-img", "Captura de pantalla.png", "image/png"),
    // Sin la clave siquiera, que es como llega todo lo de la integración.
    adjunto("a-sin-tipo", "otra-captura.jpg"),
    // Y con la clave vacía, que es el otro caso que existió.
    adjunto("a-tipo-vacio", "tercera.webp", ""),
    adjunto("a-pdf", "contrato.pdf", "application/pdf"),
  ],
  comments: [], subtasks: [], tags: [], assignees: [],
  listName: "tasks", spaceName: "Portento", folio: "portento-100",
  status: { id: "li-1/pending", name: "Open", kind: "open", color: "#888", listId: "li-1" },
};

vi.mock("@/lib/media", () => ({
  mediaSrc: (u?: string) => (u ? `cacmedia://${u}` : undefined),
  openAttachment: vi.fn(),
  attachmentPath: (u?: string) => u ?? null,
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) => sel(estado.current),
}));
// Invocable **y** con getState/subscribe: people.store se suscribe al importarse
// para vaciar los nombres de otro equipo al cerrar sesión.
vi.mock("@/store/auth.store", () => {
  const estadoAuth = { session: { id: "u-1" }, accessToken: "t" };
  return {
    useAuthStore: Object.assign(
      (sel: (s: typeof estadoAuth) => unknown) => sel(estadoAuth),
      { getState: () => estadoAuth, subscribe: () => () => {} },
    ),
  };
});
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));
vi.mock("@/components/markdown/Markdown", () => ({ default: () => null }));
vi.mock("@/components/UserPicker", () => ({ default: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/PromptDialog", () => ({ usePrompt: () => async () => "" }));

const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");

beforeEach(() => {
  estado.current = {
    openTaskId: "t-1", detail: detalle, loadingDetail: false, detailError: null,
    closeTask: () => {}, updateTask: vi.fn(), deleteTask: vi.fn(), addComment: vi.fn(),
    editComment: vi.fn(), deleteComment: vi.fn(), uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(), createTag: vi.fn(), tags: [], statusesOf: async () => [],
    createSubtask: vi.fn(), openTask: vi.fn(), refreshOpenTask: vi.fn(), tree: [],
  };
});
afterEach(cleanup);

describe("la galería de una tarjeta", () => {
  it("pinta las imágenes, y también las que vienen sin contentType", () => {
    render(<TaskDetailDrawer />);
    const vistas = screen.getAllByRole("img").map((i) => i.getAttribute("alt"));
    expect(vistas).toContain("Captura de pantalla.png");
    // La integración nunca declara el tipo; la extensión decide entonces.
    expect(vistas).toContain("otra-captura.jpg");
    expect(vistas).toContain("tercera.webp");
  });

  it("el PDF no se pinta como imagen: tiene su propio visor", () => {
    render(<TaskDetailDrawer />);
    const vistas = screen.getAllByRole("img").map((i) => i.getAttribute("alt"));
    expect(vistas).not.toContain("contrato.pdf");
    expect(screen.getByText("contrato.pdf")).toBeTruthy();
  });

  it("al pulsarla se abre entera, que es de lo que iba todo esto", () => {
    render(<TaskDetailDrawer />);
    const mini = screen.getAllByRole("img").find((i) => i.getAttribute("alt") === "Captura de pantalla.png");
    fireEvent.click(mini!.closest("button")!);
    // El lightbox monta una segunda copia, a tamaño completo, fuera del cajón.
    const copias = screen.getAllByRole("img").filter((i) => i.getAttribute("alt") === "Captura de pantalla.png");
    expect(copias.length).toBe(2);
  });
});
