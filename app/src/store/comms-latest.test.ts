import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La última línea de cada canal y la marca de lectura de un directo, en las
 * stores. Mutantes: no pedir `/chat/latest`; que un backend sin la ruta rompa
 * los no leídos; que `onRead` toque otra conversación.
 */
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }, apiUrl: (p: string) => p }));

const { useChatStore } = await import("./chat.store");
const { useDMStore } = await import("./dm.store");

beforeEach(() => get.mockReset());

describe("la lista de canales", () => {
  it("trae los no leídos y la última línea de una vez", async () => {
    get.mockImplementation(async (url: string) =>
      url === "/api/v1/chat/unread"
        ? { data: [{ spaceId: "sp-1", count: 2 }] }
        : { data: [{ spaceId: "sp-1", authorUserId: "u", authorName: "Bea", body: "hola", createdAt: "2026-10-15T10:00:00Z" }] },
    );
    await useChatStore.getState().fetchUnread();
    expect(useChatStore.getState().unreadBySpace).toEqual({ "sp-1": 2 });
    expect(useChatStore.getState().latestBySpace["sp-1"]?.body).toBe("hola");
  });

  it("un backend sin la ruta deja los no leídos igual", async () => {
    get.mockImplementation(async (url: string) => {
      if (url === "/api/v1/chat/unread") return { data: [{ spaceId: "sp-1", count: 1 }] };
      if (url === "/api/v1/chat/latest") throw new Error("404");
      return { data: [] };
    });
    await useChatStore.getState().fetchUnread();
    expect(useChatStore.getState().unreadBySpace).toEqual({ "sp-1": 1 });
    expect(useChatStore.getState().latestBySpace).toEqual({});
  });
});

describe("la marca de lectura de un directo", () => {
  it("sólo cambia la conversación que se leyó", () => {
    useDMStore.setState({
      conversations: [
        { conversationId: "c-1", orgId: "o", userId: "u", username: "a", unread: 0 },
        { conversationId: "c-2", orgId: "o", userId: "v", username: "b", unread: 0 },
      ] as never,
    });
    useDMStore.getState().onRead("c-2", "2026-10-15T10:00:00Z");
    const [c1, c2] = useDMStore.getState().conversations;
    expect(c2.otherReadAt).toBe("2026-10-15T10:00:00Z");
    expect(c1.otherReadAt).toBeUndefined();
  });
});
