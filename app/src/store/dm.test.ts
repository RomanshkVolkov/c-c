import { beforeEach, describe, expect, it, vi } from "vitest";

// The bookkeeping of a private conversation.
//
// The parts worth pinning are the ones that would be wrong quietly: a thread
// left on screen under somebody else's name, and an unread badge that doesn't
// clear.

let messages: unknown[] = [];
let conversations: unknown[] = [];
const get = vi.fn(async (path: string) =>
  path === "/api/v1/dm/"
    ? { success: true, data: conversations }
    : { success: true, data: messages },
);
const post = vi.fn(async (_p: string, _b?: unknown, _a?: boolean) => ({
  success: true,
  data: { id: "c-1" },
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown, auth?: boolean) => post(path, body, auth),
    patch: vi.fn(async () => ({ success: true, data: {} })),
    delete: vi.fn(async () => ({ success: true, data: {} })),
  },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
}));

const { useDMStore } = await import("@/store/dm.store");

beforeEach(() => {
  vi.clearAllMocks();
  messages = [];
  conversations = [];
  useDMStore.setState({ conversations: [], messages: [], conversationId: null, hasMore: true });
});

describe("opening a conversation", () => {
  it("asks for it by the person, not by a thread that may not exist", async () => {
    await useDMStore.getState().openWith("org-1", "u-bea");
    expect(post).toHaveBeenCalledWith("/api/v1/dm/open", { orgId: "org-1", userId: "u-bea" }, true);
  });

  it("drops the previous thread the instant you switch", async () => {
    messages = [{ id: "m-1", createdAt: "2026-08-15T10:00:00Z", body: "hola" }];
    await useDMStore.getState().open("c-1");
    expect(useDMStore.getState().messages).toHaveLength(1);

    let release!: () => void;
    get.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ success: true, data: [] }); }),
    );
    const inFlight = useDMStore.getState().open("c-2");
    // The window that matters: while this is open, the old thread would be on
    // screen under the new person's name.
    expect(useDMStore.getState().conversationId).toBe("c-2");
    expect(useDMStore.getState().messages).toEqual([]);
    release();
    await inFlight;
  });

  it("ignores a load that finishes after you moved on", async () => {
    let release!: () => void;
    get.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({ success: true, data: [{ id: "stale", createdAt: "x", body: "vieja" }] });
      }),
    );
    const slow = useDMStore.getState().open("c-1");
    messages = [];
    await useDMStore.getState().open("c-2");
    release();
    await slow;
    expect(useDMStore.getState().conversationId).toBe("c-2");
    expect(useDMStore.getState().messages).toEqual([]);
  });
});

describe("unread", () => {
  it("clears the badge on read rather than waiting for a refetch", async () => {
    useDMStore.setState({
      conversations: [
        { conversationId: "c-1", orgId: "o", userId: "u-bea", username: "bea", unread: 4 },
        { conversationId: "c-2", orgId: "o", userId: "u-ana", username: "ana", unread: 1 },
      ],
    });
    await useDMStore.getState().markRead("c-1");
    const after = useDMStore.getState().conversations;
    expect(after.find((c) => c.conversationId === "c-1")!.unread).toBe(0);
    // And leaves the other alone.
    expect(after.find((c) => c.conversationId === "c-2")!.unread).toBe(1);
  });

  it("refreshes the list when a message lands in a thread you aren't reading", async () => {
    useDMStore.setState({ conversationId: "c-1" });
    await useDMStore.getState().onIncoming("c-2");
    expect(get).toHaveBeenCalledWith("/api/v1/dm/");
  });
});
