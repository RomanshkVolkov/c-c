import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * La referencia de una tarea en su cajón (cac#203): lo que se pega en un
 * commit para que cac lo enlace.
 */

const { estado } = vi.hoisted(() => ({ estado: { current: {} as Record<string, unknown> } }));

const tarjeta = (extra: Record<string, unknown>) => ({
  task: {
    id: "t-1", seq: 101, title: "Inventario de propiedades", description: "",
    priority: "high", status: "pending", listId: "li-1", orgId: "o-1",
    projectId: "p-portento", visibility: "public",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...extra,
  },
  attachments: [], comments: [], subtasks: [], tags: [], assignees: [],
  listName: "tasks", spaceName: "Portento", folio: "portento-101",
  status: { id: "li-1/pending", name: "Open", kind: "open", color: "#888", listId: "li-1" },
});

vi.mock("@/lib/media", () => ({
  isPdfAttachment: () => false,
  linkClickAction: () => "edit",
  mediaSrc: (u?: string) => u,
  openAttachment: vi.fn(),
  attachmentPath: (u?: string) => u ?? null,
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) => sel(estado.current),
}));
vi.mock("@/store/auth.store", () => {
  const estadoAuth = { session: { id: "u-1" }, accessToken: "t" };
  return {
    useAuthStore: Object.assign((sel: (s: typeof estadoAuth) => unknown) => sel(estadoAuth), {
      getState: () => estadoAuth,
      subscribe: () => () => {},
    }),
  };
});
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));
vi.mock("@/components/markdown/Markdown", () => ({ default: () => null }));
vi.mock("@/components/UserPicker", () => ({ default: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/PromptDialog", () => ({ usePrompt: () => async () => "" }));

const { default: TaskDetailDrawer } = await import("@/components/TaskDetailDrawer");
const { useOrgsStore } = await import("@/store/orgs.store");
// La tarea es de esta org: el cajón no pinta una tarea de otra.
beforeEach(() => useOrgsStore.setState({ currentOrgId: "o-1" }));

const montar = (extra: Record<string, unknown>, detalle: Record<string, unknown> = {}) => {
  estado.current = {
    openTaskId: "t-1", detail: { ...tarjeta(extra), ...detalle }, loadingDetail: false, detailError: null,
    closeTask: () => {}, updateTask: vi.fn(), deleteTask: vi.fn(), addComment: vi.fn(),
    editComment: vi.fn(), deleteComment: vi.fn(), uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(), createTag: vi.fn(), tags: [], statusesOf: async () => [],
    createSubtask: vi.fn(), openTask: vi.fn(), refreshOpenTask: vi.fn(), tree: [],
  };
  return render(<TaskDetailDrawer />);
};


beforeEach(() => cleanup());
afterEach(cleanup);

describe("la referencia de la tarea", () => {
  // Roturas que detecta: no enseñar la referencia de una tarea interna (sólo
  // tenían chip las de cliente), o enseñar el número a secas en su lugar.
  it("una interna enseña la clave de su espacio y su número", () => {
    montar({ projectId: "", visibility: "internal" }, { folio: undefined, ref: "proteus-12" });
    expect(screen.getByText("proteus-12")).toBeTruthy();
    expect(screen.queryByText(/· #101/)).toBeNull();
  });

  it("una de cliente, su folio", () => {
    montar({}, { ref: "portento-101" });
    expect(screen.getByText("portento-101")).toBeTruthy();
  });

  // Un backend de antes no da `ref`: el número a secas, como siempre.
  it("sin referencia, el número", () => {
    montar({ projectId: "", visibility: "internal" }, { folio: undefined });
    expect(screen.getByText(/#101/)).toBeTruthy();
  });
});
