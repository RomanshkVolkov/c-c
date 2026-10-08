import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Lo que llega de GitHub, en el cajón de la tarea.
 *
 * Una línea que puso el webhook no tiene persona detrás, y firmaba «unknown»:
 * parecía un comentario de alguien borrado. Ahora firma GitHub. Y el panel
 * «Desarrollo» sale cuando hay algo enlazado, encima de la actividad.
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

const montar = (extra: Record<string, unknown>) => {
  estado.current = {
    openTaskId: "t-1", detail: tarjeta(extra), loadingDetail: false, detailError: null,
    closeTask: () => {}, updateTask: vi.fn(), deleteTask: vi.fn(), addComment: vi.fn(),
    editComment: vi.fn(), deleteComment: vi.fn(), uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(), createTag: vi.fn(), tags: [], statusesOf: async () => [],
    createSubtask: vi.fn(), openTask: vi.fn(), refreshOpenTask: vi.fn(), tree: [],
  };
  return render(<TaskDetailDrawer />);
};


beforeEach(() => cleanup());
afterEach(cleanup);

const comentario = (extra: Record<string, unknown>) => ({
  id: "c-1", taskId: "t-1", body: "PR abierta", internal: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  ...extra,
});

describe("lo que llega de GitHub", () => {
  it("una línea del webhook firma GitHub, no «unknown»", () => {
    montar({});
    estado.current.detail = { ...(estado.current.detail as object), comments: [comentario({ source: "gh" })] };
    cleanup();
    render(<TaskDetailDrawer />);
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  it("un comentario de una persona sigue firmando con su nombre", () => {
    montar({});
    estado.current.detail = {
      ...(estado.current.detail as object),
      comments: [comentario({ author: { kind: "user", name: "Ana Pérez" } })],
    };
    cleanup();
    render(<TaskDetailDrawer />);
    expect(screen.getByText("Ana Pérez")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("con una PR enlazada sale el panel Desarrollo", () => {
    montar({});
    estado.current.detail = {
      ...(estado.current.detail as object),
      git: {
        summary: { branches: 0, prs: 1, commits: 0, prBadge: "open" },
        branches: [], commits: [],
        prs: [{ itemId: "t-1", repoId: 1, repoFullName: "acme/web", kind: "pr", key: "3", title: "login",
          htmlUrl: "", authorLogin: "ana", state: "open", via: "text", occurredAt: "" }],
      },
    };
    cleanup();
    render(<TaskDetailDrawer />);
    expect(screen.getByRole("region", { name: "Development" })).toBeTruthy();
  });

  it("sin nada enlazado no hay panel", () => {
    montar({});
    expect(screen.queryByRole("region", { name: "Development" })).toBeNull();
  });
});
