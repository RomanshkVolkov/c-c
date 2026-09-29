import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * En una ventana estrecha, las propiedades van **debajo** de la descripción.
 *
 * Por debajo de 1024 px el panel de propiedades es `w-full shrink-0`: pide todo
 * el ancho y no encoge. Con el contenedor en fila eso deja a la descripción sin
 * sitio, y se leía en vertical, letra a letra (#81). Lo que la salva es que el
 * contenedor pase a columna en estrecho.
 *
 * Se comprueba por clases porque jsdom no calcula maquetación, y es la única
 * forma de vigilarlo aquí: todas las pruebas de esta suite montan la pantalla
 * «ancha», así que esto no lo iba a ver ninguna otra. Es el mismo trato que la
 * medida de lectura de un documento en `markdown/enlaces.test.tsx`.
 */

const get = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));
vi.mock("@/components/markdown/Markdown", () => ({ default: () => null }));

const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");
const { useOrgsStore } = await import("@/store/orgs.store");
// La tarea es de esta org: el cajón no pinta una tarea de otra.
beforeEach(() => useOrgsStore.setState({ currentOrgId: "org-1" }));
const { useTasksStore } = await import("@/store/tasks.store");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

beforeEach(() => {
  get.mockResolvedValue({ success: true, data: [] });
  useTasksStore.setState({
    openTaskId: "t-1",
    detail: {
      task: {
        id: "t-1", seq: 66, title: "Una tarea", listId: "li-1", orgId: "org-1",
        priority: "normal", statusId: "s-open", visibility: "internal", description: "",
      },
      status: { id: "s-open", name: "Open", color: "#888", kind: "open" },
      spaceName: "Uno", listName: "Lista", tags: [], assignees: [], comments: [],
      attachments: [], subtasks: [], backlinks: [],
    },
    loadingDetail: false,
  } as never);
});
afterEach(() => {
  get.mockReset();
  cleanup();
});

describe("la maqueta del detalle", () => {
  /** El mutante que mata: quitar `flex-col` del contenedor. */
  it("apila las propiedades debajo de la descripción en estrecho, y las pone al lado en ancho", async () => {
    render(
      <ConfirmProvider>
        <PromptProvider>
          <TaskDetailDrawer />
        </PromptProvider>
      </ConfirmProvider>,
    );
    // Por su ancho en `lg` y no por la etiqueta: el cajón entero también es un
    // `<aside>`, y es el primero que sale. Con él la prueba miraba la carcasa.
    const aside = await waitFor(() => {
      const a = Array.from(document.querySelectorAll("aside")).find((el) =>
        el.className.split(/\s+/).includes("lg:w-72"),
      );
      if (!a) throw new Error("sin panel de propiedades");
      return a;
    });
    const clases = aside.parentElement!.className.split(/\s+/);
    expect(clases).toContain("flex-col");
    expect(clases).toContain("lg:flex-row");
    // Y debajo, no encima: la descripción va primero en el orden del documento.
    expect(aside.previousElementSibling).not.toBeNull();
  });
});
