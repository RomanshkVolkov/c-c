import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El store del muro. Lo que se fija:
 * 1. Reaccionar es optimista en la tarjeta y en el modal, y se deshace si el
 *    servidor no la acepta.
 * 2. El punto de «nuevo» se enciende con lo que llega fuera del muro y no con
 *    el muro delante; abrirlo lo apaga.
 * 3. Una publicación borrada desaparece de la lista y cierra su modal.
 */
const { get, post, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post, delete: del, postForm: vi.fn() } }));

const { usePostsStore } = await import("./posts.store");
const { useAuthStore } = await import("@/store/auth.store");

const p = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: "feedback", audience: "platform", authorId: "u-x", authorName: "X", title: id, body: "b",
  createdAt: "2026-10-19T10:00:00Z", comments: 0, reactions: [], unseen: false, canDelete: false, ...over,
});

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
  usePostsStore.getState().reset();
  useAuthStore.setState({ session: { id: "u-me", username: "yo", name: "Yo" } } as never);
});

describe("el muro", () => {
  it("reaccionar es optimista y se deshace si falla", async () => {
    usePostsStore.setState({ posts: [p("a")] as never, open: { ...p("a"), commentList: [] } as never });
    let release!: (v: unknown) => void;
    post.mockReturnValue(new Promise((r) => (release = r)));
    const going = usePostsStore.getState().react("a", "🎉", true);
    expect(usePostsStore.getState().posts[0].reactions).toEqual([{ emoji: "🎉", count: 1, mine: true, names: ["Yo"] }]);
    expect(usePostsStore.getState().open?.reactions[0]?.emoji).toBe("🎉");
    release({ success: true });
    await going;

    post.mockRejectedValue(new Error("bad-reaction"));
    await expect(usePostsStore.getState().react("a", "👀", true)).rejects.toThrow();
    expect(usePostsStore.getState().posts[0].reactions.map((r) => r.emoji)).toEqual(["🎉"]);
    expect(usePostsStore.getState().open?.reactions.map((r) => r.emoji)).toEqual(["🎉"]);
  });

  it("lo nuevo enciende el punto fuera del muro, no delante; abrirlo lo apaga", async () => {
    get.mockResolvedValue({ success: true, data: { posts: [p("a", { unseen: true })] } });
    await usePostsStore.getState().load();
    expect(usePostsStore.getState().hasNew).toBe(true);

    usePostsStore.getState().setViewing(true);
    expect(usePostsStore.getState().hasNew).toBe(false);
    post.mockResolvedValue({ success: true });
    await usePostsStore.getState().onEvent("post:new", { postId: "b" });
    expect(usePostsStore.getState().hasNew).toBe(false);

    usePostsStore.getState().setViewing(false);
    await usePostsStore.getState().onEvent("post:new", { postId: "c" });
    expect(usePostsStore.getState().hasNew).toBe(true);
    await usePostsStore.getState().markSeen();
    expect(usePostsStore.getState().hasNew).toBe(false);
    expect(post).toHaveBeenCalledWith("/api/v1/posts/seen", {}, true);
  });

  it("una publicación borrada desaparece y cierra su modal", async () => {
    usePostsStore.setState({ posts: [p("a"), p("b")] as never, open: { ...p("a"), commentList: [] } as never });
    await usePostsStore.getState().onEvent("post:deleted", { postId: "a" });
    expect(usePostsStore.getState().posts.map((x) => x.id)).toEqual(["b"]);
    expect(usePostsStore.getState().open).toBeNull();
  });
});
