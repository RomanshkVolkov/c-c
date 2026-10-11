import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reaccionar desde el canal y desde un directo: se pinta en el acto, se manda
 * a la ruta de **ese** mensaje y, si el servidor dice que no, se deshace.
 * Y el evento de otra persona relee sólo lo que está abierto.
 * Mutantes: no deshacer al fallar; otra ruta; no pintar antes de la vuelta;
 * releer un canal que no es el abierto; no escuchar el evento en la web.
 */
const post = vi.fn();
const get = vi.fn(async () => ({ success: true, data: [] }));
vi.mock("@/lib/api", () => ({
  api: {
    get: (...a: unknown[]) => get(...(a as [])),
    post: (...a: unknown[]) => post(...a),
    patch: vi.fn(),
    delete: vi.fn(),
    postForm: vi.fn(),
  },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: {
    getState: () => ({ accessToken: "t", session: { id: "u-ana", username: "ana", name: "Ana" } }),
    subscribe: () => () => {},
  },
}));

const { useChatStore } = await import("@/store/chat.store");
const { useDMStore } = await import("@/store/dm.store");

const msg = { id: "m-1", body: "hola", createdAt: "2026-10-11T10:00:00Z", updatedAt: "", authorUserId: "u-bea", authorName: "Bea" };

beforeEach(() => {
  post.mockReset();
  get.mockClear();
  useChatStore.setState({
    spaceId: "sp-1",
    messages: [{ ...msg, spaceId: "sp-1", reactions: [{ emoji: "👍", count: 1, mine: false, names: ["Bea"] }] }],
  });
  useDMStore.setState({ conversationId: "c-1", messages: [{ ...msg, conversationId: "c-1" }] });
});

describe("reaccionar en el canal", () => {
  it("se ve antes de que conteste el servidor, y va a la ruta de ese mensaje", async () => {
    let soltar!: () => void;
    post.mockReturnValue(new Promise<void>((r) => (soltar = r)));
    const p = useChatStore.getState().react("sp-1", "m-1", "👍", true);
    expect(useChatStore.getState().messages[0].reactions).toEqual([
      { emoji: "👍", count: 2, mine: true, names: ["Bea", "Ana"] },
    ]);
    expect(post).toHaveBeenCalledWith("/api/v1/task-spaces/sp-1/chat/m-1/reactions", { emoji: "👍", on: true }, true);
    soltar();
    await p;
  });

  it("si el servidor dice que no, se deshace", async () => {
    post.mockRejectedValue(new Error("400"));
    await expect(useChatStore.getState().react("sp-1", "m-1", "🎉", true)).rejects.toThrow();
    expect(useChatStore.getState().messages[0].reactions).toEqual([
      { emoji: "👍", count: 1, mine: false, names: ["Bea"] },
    ]);
  });

  it("la reacción de otra persona relee el canal abierto, y no otro", async () => {
    await useChatStore.getState().onReaction("sp-otro");
    expect(get).not.toHaveBeenCalled();
    await useChatStore.getState().onReaction("sp-1");
    expect(get).toHaveBeenCalled();
  });
});

describe("reaccionar en un directo", () => {
  it("va a la ruta de la conversación y se deshace si falla", async () => {
    post.mockRejectedValue(new Error("404"));
    await expect(useDMStore.getState().react("c-1", "m-1", "❤️", true)).rejects.toThrow();
    expect(post).toHaveBeenCalledWith("/api/v1/dm/c-1/messages/m-1/reactions", { emoji: "❤️", on: true }, true);
    expect(useDMStore.getState().messages[0].reactions).toBeUndefined();
  });

  it("la de otra persona relee la conversación abierta, y no otra", async () => {
    await useDMStore.getState().onReaction("c-otra");
    expect(get).not.toHaveBeenCalled();
    await useDMStore.getState().onReaction("c-1");
    expect(get).toHaveBeenCalled();
  });
});

describe("los eventos", () => {
  const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");
  it("se escuchan también en la web", () => {
    const s = fuente();
    const lista = s.slice(s.indexOf("for (const kind of ["), s.indexOf("es.addEventListener(kind"));
    expect(lista).toContain('"chat:reaction"');
    expect(lista).toContain('"dm:reaction"');
  });
  it("no dejan fila en la campana: una reacción no es un mensaje", () => {
    const s = fuente();
    const filas = s.slice(s.indexOf("const DEJAN_FILA"), s.indexOf("]);", s.indexOf("const DEJAN_FILA")));
    expect(filas).not.toContain("reaction");
  });
});
