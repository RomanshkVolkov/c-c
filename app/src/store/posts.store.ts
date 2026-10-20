import { create } from "zustand";

import { api } from "@/lib/api";
import { nombreDe } from "@/lib/nombres";
import { applyReaction } from "@/lib/reactions";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";
import type { CreatePostPayload, Post, PostDetail, PostPage, UpdatePostPayload } from "@/types/post";

/**
 * El muro de feedback y comunicados (backend: `domain/post.go`).
 *
 * Quién ve qué lo decide el servidor; aquí sólo se pinta lo que llega. Los
 * eventos del stream (`post:*`) sólo traen ids, así que al recibir uno se
 * vuelve a pedir lo que hay en pantalla: el stream nunca trae algo que no se
 * pueda ver.
 */
interface PostsState {
  posts: Post[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  /** La publicación abierta en el modal. */
  open: PostDetail | null;
  /** Hay algo publicado desde la última vez que se abrió el muro (el punto de la barra). */
  hasNew: boolean;
  /** El muro está en pantalla: lo que llega ya se está viendo. */
  viewing: boolean;

  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  openPost: (id: string) => Promise<void>;
  closePost: () => void;
  create: (p: CreatePostPayload) => Promise<PostDetail>;
  remove: (id: string) => Promise<void>;
  update: (id: string, p: UpdatePostPayload) => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  /** Saca un borrador: deja de serlo y sale como nuevo para todos. */
  publish: (id: string) => Promise<void>;
  reactComment: (postId: string, commentId: string, emoji: string, on: boolean) => Promise<void>;
  comment: (id: string, body: string) => Promise<void>;
  removeComment: (postId: string, commentId: string) => Promise<void>;
  react: (id: string, emoji: string, on: boolean) => Promise<void>;
  setViewing: (on: boolean) => void;
  markSeen: () => Promise<void>;
  upload: (file: File) => Promise<{ url: string; fileName: string }>;
  /** Un `post:*` del stream. */
  onEvent: (type: string, data: { postId?: string }) => Promise<void>;
  /** Vuelve a pedir una publicación que está en pantalla; si ya no se puede ver, la quita. */
  refreshOne: (id: string) => Promise<void>;
  /** La primera página, por encima de lo ya cargado. */
  mergeFirstPage: () => Promise<void>;
  reset: () => void;
}

function must<T>(r: APIResponse<T>): T {
  if (!r.success || r.data === undefined) throw new Error(r.error ?? "post-failed");
  return r.data;
}

const initial = { posts: [], nextCursor: null, loaded: false, loading: false, open: null, hasNew: false, viewing: false };

export const usePostsStore = create<PostsState>((set, get) => ({
  ...initial,

  load: async () => {
    set({ loading: true });
    try {
      const page = must(await api.get<APIResponse<PostPage>>("/api/v1/posts", true));
      set((s) => ({
        posts: page.posts,
        nextCursor: page.nextCursor ?? null,
        loaded: true,
        // Con el muro delante, lo nuevo ya se está viendo.
        hasNew: !s.viewing && page.posts.some((p) => p.unseen),
      }));
    } finally {
      set({ loading: false });
    }
  },

  loadMore: async () => {
    const cursor = get().nextCursor;
    if (!cursor || get().loading) return;
    set({ loading: true });
    try {
      const page = must(
        await api.get<APIResponse<PostPage>>(`/api/v1/posts?cursor=${encodeURIComponent(cursor)}`, true),
      );
      set((s) => ({ posts: [...s.posts, ...page.posts], nextCursor: page.nextCursor ?? null }));
    } finally {
      set({ loading: false });
    }
  },

  openPost: async (id) => {
    const detail = must(await api.get<APIResponse<PostDetail>>(`/api/v1/posts/${id}`, true));
    set({ open: detail });
  },

  closePost: () => set({ open: null }),

  create: async (p) => {
    const detail = must(await api.post<APIResponse<PostDetail>>("/api/v1/posts", p, true));
    await get().load();
    return detail;
  },

  remove: async (id) => {
    must(await api.delete<APIResponse<unknown>>(`/api/v1/posts/${id}`));
    set((s) => ({ posts: s.posts.filter((p) => p.id !== id), open: s.open?.id === id ? null : s.open }));
  },

  update: async (id, p) => {
    const detail = must(await api.patch<APIResponse<PostDetail>>(`/api/v1/posts/${id}`, p, true));
    set((s) => ({
      open: s.open?.id === id ? detail : s.open,
      posts: s.posts.map((x) => (x.id === id ? { ...x, ...detail } : x)),
    }));
  },

  publish: async (id) => {
    const detail = must(await api.post<APIResponse<PostDetail>>(`/api/v1/posts/${id}/publish`, {}, true));
    set((s) => ({ open: s.open?.id === id ? detail : s.open }));
    await get().load();
  },

  pin: async (id, pinned) => {
    const detail = must(await api.post<APIResponse<PostDetail>>(`/api/v1/posts/${id}/pin`, { pinned }, true));
    set((s) => ({ open: s.open?.id === id ? detail : s.open }));
    // Fijar mueve la publicación de sitio: el orden lo da el servidor.
    await get().load();
  },

  // Optimista, como la de la publicación, pero sólo en el modal: es el único
  // sitio donde se ven los comentarios.
  reactComment: async (postId, commentId, emoji, on) => {
    const prev = get().open?.commentList.find((c) => c.id === commentId)?.reactions;
    const session = useAuthStore.getState().session;
    const me = session ? nombreDe(session) : "";
    const put = (fn: (r: PostDetail["commentList"][number]["reactions"]) => typeof prev) =>
      set((s) =>
        s.open?.id !== postId
          ? s
          : {
              open: {
                ...s.open,
                commentList: s.open.commentList.map((c) => (c.id === commentId ? { ...c, reactions: fn(c.reactions) ?? [] } : c)),
              },
            },
      );
    put((r) => applyReaction(r, emoji, on, me));
    try {
      await api.post(`/api/v1/posts/${postId}/comments/${commentId}/reactions`, { emoji, on }, true);
    } catch (e) {
      put(() => prev);
      throw e;
    }
  },

  comment: async (id, body) => {
    const detail = must(await api.post<APIResponse<PostDetail>>(`/api/v1/posts/${id}/comments`, { body }, true));
    set((s) => ({
      open: s.open?.id === id ? detail : s.open,
      posts: s.posts.map((p) => (p.id === id ? { ...p, comments: detail.commentList.length } : p)),
    }));
  },

  removeComment: async (postId, commentId) => {
    must(await api.delete<APIResponse<unknown>>(`/api/v1/posts/${postId}/comments/${commentId}`));
    set((s) => {
      if (s.open?.id !== postId) return s;
      const commentList = s.open.commentList.filter((c) => c.id !== commentId);
      return {
        open: { ...s.open, commentList },
        posts: s.posts.map((p) => (p.id === postId ? { ...p, comments: commentList.length } : p)),
      };
    });
  },

  // Optimista, como en el chat: se pinta ya y se deshace si el servidor no la
  // acepta. En la tarjeta y en el modal a la vez.
  react: async (id, emoji, on) => {
    const prevList = get().posts.find((p) => p.id === id)?.reactions;
    const prevOpen = get().open?.id === id ? get().open?.reactions : undefined;
    const session = useAuthStore.getState().session;
    const me = session ? nombreDe(session) : "";
    set((s) => ({
      posts: s.posts.map((p) => (p.id === id ? { ...p, reactions: applyReaction(p.reactions, emoji, on, me) } : p)),
      open: s.open?.id === id ? { ...s.open, reactions: applyReaction(s.open.reactions, emoji, on, me) } : s.open,
    }));
    try {
      await api.post(`/api/v1/posts/${id}/reactions`, { emoji, on }, true);
    } catch (e) {
      set((s) => ({
        posts: s.posts.map((p) => (p.id === id && prevList ? { ...p, reactions: prevList } : p)),
        open: s.open?.id === id && prevOpen ? { ...s.open, reactions: prevOpen } : s.open,
      }));
      throw e;
    }
  },

  setViewing: (on) => set(on ? { viewing: true, hasNew: false } : { viewing: false }),

  markSeen: async () => {
    set({ hasNew: false });
    await api.post("/api/v1/posts/seen", {}, true);
  },

  upload: async (file) => {
    const form = new FormData();
    form.append("file", file);
    const res = await api.postForm<{ data: { url: string; fileName: string } }>("/api/v1/posts/attachments", form);
    return { url: res.data.url, fileName: res.data.fileName };
  },

  // Nada de recargar el muro entero por un evento: se perderían las páginas
  // de «Cargar más», y con una reacción a algo «para todos» cada cliente
  // conectado pediría la primera página. Sólo se pide lo que hay en pantalla.
  onEvent: async (type, data) => {
    const id = data.postId;
    if (!id) return;
    if (type === "post:deleted") {
      set((s) => ({ posts: s.posts.filter((p) => p.id !== id), open: s.open?.id === id ? null : s.open }));
      return;
    }
    if (type === "post:new") {
      // Un evento «para todos» llega también a quien no puede verlo (por
      // ejemplo, sin organización): sólo cuenta si la publicación se abre.
      const seen = await api.get<APIResponse<PostDetail>>(`/api/v1/posts/${id}`, true).then(must).catch(() => null);
      if (!seen) return;
      if (get().viewing) await get().mergeFirstPage().catch(() => {});
      else if (seen.authorId !== useAuthStore.getState().session?.id) set({ hasNew: true });
      return;
    }
    const { posts, open } = get();
    if (posts.some((p) => p.id === id) || open?.id === id) await get().refreshOne(id);
  },

  refreshOne: async (id) => {
    const detail = await api.get<APIResponse<PostDetail>>(`/api/v1/posts/${id}`, true).then(must).catch(() => null);
    set((s) => {
      if (!detail) return { posts: s.posts.filter((p) => p.id !== id), open: s.open?.id === id ? null : s.open };
      const { commentList: _comments, ...card } = detail;
      return {
        posts: s.posts.map((p) => (p.id === id ? { ...p, ...card } : p)),
        open: s.open?.id === id ? detail : s.open,
      };
    });
  },

  // Lo nuevo arriba sin perder lo que ya se había cargado debajo.
  mergeFirstPage: async () => {
    const page = must(await api.get<APIResponse<PostPage>>("/api/v1/posts", true));
    set((s) => {
      const fresh = new Set(page.posts.map((p) => p.id));
      const rest = s.posts.filter((p) => !fresh.has(p.id));
      return { posts: [...page.posts, ...rest], nextCursor: rest.length ? s.nextCursor : (page.nextCursor ?? null) };
    });
  },

  reset: () => set(initial),
}));
