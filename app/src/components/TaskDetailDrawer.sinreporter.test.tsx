import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Cuando el cliente puede leer el hilo pero no hay a quién avisar.
 *
 * El webhook sale igual; lo que no hay es destinatario. Los receptores enrutan
 * el aviso por `reporterId` —así está escrito en el contrato, §5.b— y un
 * reporte que levantamos nosotros no tiene reporter. El evento llega y no
 * notifica a nadie.
 *
 * Salió de una explicación larga escrita en `portento-101` que esperó respuesta
 * tres días. Nada en la pantalla decía que al otro lado no había nadie, y por
 * eso los dos casos de abajo son ese reporte y su vecino `portento-97`, que sí
 * tiene reporter y sí recibió respuesta.
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

/** El aviso, buscado por lo que significa y no por su texto exacto. */
const aviso = () => screen.queryByText(/will not notify anyone/i);

beforeEach(() => cleanup());
afterEach(cleanup);

describe("un reporte sin reporter", () => {
  // portento-101: lo levantamos nosotros, `reporterId` vacío.
  it("avisa de que el comentario no le llega a nadie", () => {
    montar({ reporterId: "", origin: "internal" });
    expect(aviso()).toBeTruthy();
  });

  // portento-97: lo reportó Sebastian, y respondió a las catorce horas.
  it("con reporter no dice nada", () => {
    montar({ reporterId: "3", reporterName: "Sebastian Ramirez", origin: "user" });
    expect(aviso()).toBeNull();
  });

  // Una tarjeta interna del equipo no tiene cliente al que avisar, así que el
  // aviso sobraría: nadie espera que su comentario salga de aquí.
  it("una tarjeta sin cliente tampoco", () => {
    montar({ reporterId: "", projectId: undefined });
    expect(aviso()).toBeNull();
  });

  // Y con el comentario en modo interno tampoco: ahí no se espera aviso, así
  // que decirlo sería ruido justo cuando ya lo sabes.
  it("en modo interno se calla", () => {
    montar({ reporterId: "", origin: "internal" });
    expect(aviso()).toBeTruthy();
    fireEvent.click(screen.getByTitle(/switch to keep it internal/i));
    expect(aviso()).toBeNull();
  });
});
