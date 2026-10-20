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

  // Responde según la ruta: el detalle de cada publicación y la primera página.
  const routes = (details: Record<string, unknown>, page: unknown[] = []) =>
    get.mockImplementation(async (url: string) => {
      if (url === "/api/v1/posts") return { success: true, data: { posts: page } };
      const id = url.split("/").pop()!;
      if (id in details) return { success: true, data: details[id] };
      throw new Error("post-not-found");
    });

  it("lo nuevo enciende el punto fuera del muro, no delante; abrirlo lo apaga", async () => {
    routes({ b: { ...p("b"), commentList: [] }, c: { ...p("c"), commentList: [] } }, [p("a", { unseen: true })]);
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

  // Roturas que detecta: encender el punto sin preguntar si se puede ver, o
  // por lo que acaba de publicar uno mismo.
  it("el punto no se enciende por lo que no se puede ver ni por lo propio", async () => {
    routes({ mine: { ...p("mine", { authorId: "u-me" }), commentList: [] } });
    await usePostsStore.getState().onEvent("post:new", { postId: "ajena" });
    expect(usePostsStore.getState().hasNew).toBe(false);
    await usePostsStore.getState().onEvent("post:new", { postId: "mine" });
    expect(usePostsStore.getState().hasNew).toBe(false);
  });

  // Rotura que detecta: recargar el muro entero con lo nuevo y perder las
  // páginas de «Cargar más».
  it("lo nuevo con el muro delante entra arriba sin perder lo cargado debajo", async () => {
    usePostsStore.setState({ posts: [p("a"), p("old1"), p("old2")] as never, nextCursor: "cur", viewing: true });
    routes({ n: { ...p("n"), commentList: [] } }, [p("n"), p("a")]);
    await usePostsStore.getState().onEvent("post:new", { postId: "n" });
    expect(usePostsStore.getState().posts.map((x) => x.id)).toEqual(["n", "a", "old1", "old2"]);
    expect(usePostsStore.getState().nextCursor).toBe("cur");
  });

  // Roturas que detectan: pedir el muro entero por un comentario, o pedir el
  // detalle de algo que no está en pantalla.
  it("un comentario o reacción sólo refresca la publicación que se ve", async () => {
    usePostsStore.setState({ posts: [p("a"), p("old")] as never, nextCursor: "cur" });
    routes({ a: { ...p("a", { comments: 3 }), commentList: [] } });
    await usePostsStore.getState().onEvent("post:comment", { postId: "a" });
    expect(usePostsStore.getState().posts.map((x) => [x.id, x.comments])).toEqual([["a", 3], ["old", 0]]);
    expect(usePostsStore.getState().nextCursor).toBe("cur");
    expect(get).toHaveBeenCalledTimes(1);

    await usePostsStore.getState().onEvent("post:reaction", { postId: "fuera" });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("una publicación borrada desaparece y cierra su modal", async () => {
    usePostsStore.setState({ posts: [p("a"), p("b")] as never, open: { ...p("a"), commentList: [] } as never });
    await usePostsStore.getState().onEvent("post:deleted", { postId: "a" });
    expect(usePostsStore.getState().posts.map((x) => x.id)).toEqual(["b"]);
    expect(usePostsStore.getState().open).toBeNull();
  });
});
