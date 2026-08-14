import { beforeEach, describe, expect, it, vi } from "vitest";

// The channel's bookkeeping: what the app asks for, and what it counts.
//
// Everything here is about a number in the navigator being right. A badge that
// counts your own message, or one that survives reading the channel, trains
// people to ignore it — at which point the feature is decoration.

type Msg = { id: string; createdAt: string; body: string };

let page: Msg[] = [];
const get = vi.fn(async (path: string) => {
  if (path.startsWith("/api/v1/chat/unread")) {
    return { success: true, data: [{ spaceId: "sp-1", count: 3 }] };
  }
  return { success: true, data: page };
});
const post = vi.fn(async (_p: string, _b?: unknown, _a?: boolean) => ({ success: true, data: {} }));

vi.mock("@/lib/api", () => ({
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown, auth?: boolean) => post(path, body, auth),
    patch: vi.fn(async () => ({ success: true, data: {} })),
    delete: vi.fn(async () => ({ success: true, data: {} })),
    postForm: vi.fn(async () => ({ success: true, data: {} })),
  },
  apiUrl: (p: string) => p,
}));
vi.mock("@/store/auth.store", () => ({
  useAuthStore: { getState: () => ({ accessToken: "t" }), subscribe: () => () => {} },
}));

const { useChatStore } = await import("@/store/chat.store");

const msg = (id: string, at: string): Msg => ({ id, createdAt: at, body: id });

beforeEach(() => {
  get.mockClear();
  post.mockClear();
  page = [];
  useChatStore.setState({
    messages: [],
    spaceId: null,
    unreadBySpace: {},
    panelOpen: false,
    hasMore: true,
    loading: false,
    loadingOlder: false,
  });
});

describe("reading the channel", () => {
  it("asks for the newest page, with no cursor", async () => {
    await useChatStore.getState().fetch("sp-1");
    expect(get).toHaveBeenCalledWith("/api/v1/task-spaces/sp-1/chat?limit=50");
  });

  it("pages backwards from the oldest line on screen, not forwards", async () => {
    // A full page, so there is history to ask for at all.
    page = [
      msg("a", "2026-08-13T10:00:00Z"),
      ...Array.from({ length: 49 }, (_, i) => msg(`m${i}`, `2026-08-13T11:${String(i).padStart(2, "0")}:00Z`)),
    ];
    await useChatStore.getState().fetch("sp-1");
    expect(useChatStore.getState().hasMore).toBe(true);
    get.mockClear();
    page = [];
    await useChatStore.getState().fetchOlder();
    const url = get.mock.calls[0][0];
    // The first message is the oldest — the list renders top-down — so it is the
    // cursor. Using the last one would ask for older-than-newest and re-fetch
    // the same page forever.
    expect(url).toContain(`before=${encodeURIComponent("2026-08-13T10:00:00Z")}`);
  });

  it("stops asking for history once a short page comes back", async () => {
    page = [msg("a", "2026-08-13T10:00:00Z")]; // shorter than the 50 asked for
    await useChatStore.getState().fetch("sp-1");
    expect(useChatStore.getState().hasMore).toBe(false);
    get.mockClear();
    await useChatStore.getState().fetchOlder();
    expect(get).not.toHaveBeenCalled();
  });

  it("drops the previous channel's lines the instant you switch, not when the new ones land", async () => {
    page = [msg("a", "2026-08-13T10:00:00Z")];
    await useChatStore.getState().fetch("sp-1");
    expect(useChatStore.getState().messages).toHaveLength(1);

    // Hold the second load open, so the window between "switched" and "loaded"
    // is observable. That window is the whole point: while it is open, #boaty's
    // header sits above #portento's conversation.
    let release!: () => void;
    get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ success: true, data: [] });
        }),
    );
    const inFlight = useChatStore.getState().fetch("sp-2");
    expect(useChatStore.getState().spaceId).toBe("sp-2");
    expect(useChatStore.getState().messages).toEqual([]);
    release();
    await inFlight;
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("ignores a load that finishes after you already moved on", async () => {
    // Slow response for sp-1, then a quick switch to sp-2. Without the guard,
    // sp-1's lines arrive last and win — under sp-2's name.
    let release!: () => void;
    get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ success: true, data: [msg("stale", "2026-08-13T10:00:00Z")] });
        }),
    );
    const slow = useChatStore.getState().fetch("sp-1");
    page = [];
    await useChatStore.getState().fetch("sp-2");
    release();
    await slow;
    expect(useChatStore.getState().spaceId).toBe("sp-2");
    expect(useChatStore.getState().messages).toEqual([]);
  });
});

describe("the unread badge", () => {
  it("counts a message that arrives for a channel you aren't looking at", async () => {
    await useChatStore.getState().onIncoming("sp-1");
    await useChatStore.getState().onIncoming("sp-1");
    expect(useChatStore.getState().unreadBySpace["sp-1"]).toBe(2);
  });

  it("does not count one that arrives in the open channel — you are reading it", async () => {
    useChatStore.setState({ panelOpen: true, spaceId: "sp-1" });
    await useChatStore.getState().onIncoming("sp-1");
    expect(useChatStore.getState().unreadBySpace["sp-1"]).toBeUndefined();
    expect(post).toHaveBeenCalledWith("/api/v1/task-spaces/sp-1/chat/read", {}, true);
  });

  it("still counts one for another channel while a channel is open", async () => {
    useChatStore.setState({ panelOpen: true, spaceId: "sp-1" });
    await useChatStore.getState().onIncoming("sp-2");
    expect(useChatStore.getState().unreadBySpace["sp-2"]).toBe(1);
  });

  it("clears the badge on read rather than waiting for a refetch", async () => {
    useChatStore.setState({ unreadBySpace: { "sp-1": 4, "sp-2": 1 } });
    await useChatStore.getState().markRead("sp-1");
    expect(useChatStore.getState().unreadBySpace).toEqual({ "sp-2": 1 });
  });

  it("takes every space's count from one call", async () => {
    await useChatStore.getState().fetchUnread();
    expect(get).toHaveBeenCalledWith("/api/v1/chat/unread");
    expect(useChatStore.getState().unreadBySpace).toEqual({ "sp-1": 3 });
  });
});

describe("writing", () => {
  it("sends the body and marks nothing read on failure", async () => {
    await useChatStore.getState().post("sp-1", "hola");
    expect(post).toHaveBeenCalledWith("/api/v1/task-spaces/sp-1/chat", { body: "hola" }, true);
  });

  it("opening a channel reads it only after the load succeeded", async () => {
    get.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    useChatStore.setState({ unreadBySpace: { "sp-1": 2 } });
    await expect(useChatStore.getState().openPanel("sp-1")).rejects.toThrow();
    // The badge survives: nobody saw those messages, so clearing it would hide
    // them for good.
    expect(useChatStore.getState().unreadBySpace["sp-1"]).toBe(2);
    expect(post).not.toHaveBeenCalled();
  });
});
