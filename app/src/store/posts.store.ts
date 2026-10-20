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
  reactComment: (postId: string, commentId: string, emoji: string, on: boolean) => Promise<void>;
  comment: (id: string, body: string) => Promise<void>;
  removeComment: (postId: string, commentId: string) => Promise<void>;
  react: (id: string, emoji: string, on: boolean) => Promise<void>;
  setViewing: (on: boolean) => void;
  markSeen: () => Promise<void>;
  upload: (file: File) => Promise<{ url: string; fileName: string }>;
  /** Un `post:*` del stream. */
  onEvent: (type: string, data: { postId?: string }) => Promise<void>;
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
    const yo = useAuthStore.getState().session;
    const me = yo ? nombreDe(yo) : "";
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
    const yo = useAuthStore.getState().session;
    const me = yo ? nombreDe(yo) : "";
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

  onEvent: async (type, data) => {
    const { loaded, open, viewing } = get();
    if (type === "post:deleted" && data.postId) {
      set((s) => ({
        posts: s.posts.filter((p) => p.id !== data.postId),
        open: s.open?.id === data.postId ? null : s.open,
      }));
      return;
    }
    if (loaded) await get().load().catch(() => {});
    // Algo nuevo fuera del muro enciende el punto; con el muro delante, no.
    if (type === "post:new" && !viewing) set({ hasNew: true });
    if (open && data.postId === open.id) await get().openPost(open.id).catch(() => {});
  },

  reset: () => set(initial),
}));
