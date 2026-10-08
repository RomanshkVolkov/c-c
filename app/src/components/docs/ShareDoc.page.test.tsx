import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Compartir desde una página manda **la página**: su enlace por id y su título.
 * Antes de las páginas sólo había pestañas, y compartir desde una página habría
 * mandado la pestaña de la portada que quedó seleccionada detrás.
 */

const postChat = vi.fn(async (_id: string, _body: string) => {});
vi.mock("@/store/chat.store", () => ({
  useChatStore: (sel: (s: unknown) => unknown) => sel({ post: postChat }),
}));
vi.mock("@/store/dm.store", () => ({
  useDMStore: (sel: (s: unknown) => unknown) =>
    sel({ conversations: [], fetchConversations: async () => {}, post: vi.fn() }),
}));
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: unknown) => unknown) => sel({ tree: [{ id: "c1", name: "general" }] }),
}));

const { default: ShareDoc } = await import("@/components/docs/ShareDoc");

afterEach(() => {
  cleanup();
  postChat.mockClear();
});

const doc = { id: "d1", orgId: "o1", ownerKind: "list", ownerId: "l1", stale: false } as never;

let etiqueta = "";
const mandar = async (page?: { id: string; title: string }) => {
  render(<ShareDoc doc={doc} nombre="Apps" tab="runbook" page={page} />);
  fireEvent.click(screen.getByText("Share"));
  await screen.findByText("general");
  etiqueta = screen.queryByText("This page") ? "This page" : "This section";
  fireEvent.click(screen.getByText("general"));
  await waitFor(() => expect(postChat).toHaveBeenCalled());
  return postChat.mock.calls[0][1];
};

describe("compartir", () => {
  it("desde una página, la página", async () => {
    const body = await mandar({ id: "p9", title: "Nereus" });
    expect(body).toContain("[Apps · Nereus](/tasks?doc=list:l1&page=p9)");
    expect(etiqueta).toBe("This page");
  });

  it("desde la portada, la pestaña", async () => {
    const body = await mandar();
    expect(body).toContain("(/tasks?doc=list:l1&tab=runbook)");
    expect(etiqueta).toBe("This section");
  });
});
