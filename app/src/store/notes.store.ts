import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  Note,
  NoteAttachment,
  NoteDetail,
  NoteSearchResult,
  NoteTreeItem,
  NoteTreeMove,
} from "@/types/note";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface NotesState {
  tree: NoteTreeItem[];
  loadingTree: boolean;
  error: string | null;

  activeId: string | null;
  detail: NoteDetail | null;
  loadingDetail: boolean;
  /** Set right after a save resolves; cleared once the user types again. */
  savedAt: number | null;

  searchQuery: string;
  searchResults: NoteSearchResult[];
  searching: boolean;

  fetchTree: () => Promise<void>;
  openNote: (id: string) => Promise<void>;
  closeNote: () => void;
  createNote: (parentId?: string | null, title?: string) => Promise<Note | null>;
  renameNote: (id: string, title: string) => Promise<void>;
  saveBody: (id: string, body: string) => Promise<void>;
  deleteNote: (id: string) => Promise<number>;
  /** Descendant ids, for the "this deletes N subpages" confirm — read-only. */
  descendantsOf: (id: string) => string[];
  moveTree: (moves: NoteTreeMove[]) => Promise<void>;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
  /**
   * Same query as `search`, but doesn't touch searchQuery/searchResults — the
   * link picker needs its own results without fighting the ⌘P search dialog
   * over shared state (they can be open one after the other, and each should
   * start clean).
   */
  findNotes: (query: string) => Promise<NoteSearchResult[]>;
  uploadAttachment: (file: File) => Promise<{ url: string; fileName: string } | null>;
}

export const useNotesStore = create<NotesState>()(
  persist(
    (set, get) => ({
      tree: [],
      loadingTree: false,
      error: null,

      activeId: null,
      detail: null,
      loadingDetail: false,
      savedAt: null,

      searchQuery: "",
      searchResults: [],
      searching: false,

      fetchTree: async () => {
        set({ loadingTree: true, error: null });
        try {
          const res = await api.get<APIResponse<NoteTreeItem[]>>("/api/v1/notes/");
          if (res.success && res.data) set({ tree: res.data });
        } catch (e) {
          // The tree above is what we already had — persisted from the last
          // successful fetch — so a failed refresh still leaves it readable.
          set({ error: msg(e) });
        } finally {
          set({ loadingTree: false });
        }
      },

      openNote: async (id) => {
        // Show the persisted copy immediately if it's this same note — this is
        // what makes a note readable with the backend unreachable — then
        // refresh from the server. A DIFFERENT cached note is cleared so its
        // stale content doesn't flash before the new one loads; closeNote()
        // deliberately leaves `detail` alone, so the common path (Notes list →
        // reopen the note you were just reading) still finds it cached here.
        const cached = get().detail;
        set({
          activeId: id,
          loadingDetail: true,
          savedAt: null,
          detail: cached?.note.id === id ? cached : null,
        });
        try {
          const res = await api.get<APIResponse<NoteDetail>>(`/api/v1/notes/${id}`);
          if (get().activeId !== id) return; // switched away mid-flight
          if (res.success && res.data) set({ detail: res.data });
        } catch (e) {
          // Network failure with nothing cached: surface it instead of a blank
          // pane pretending the note doesn't exist.
          if (!get().detail) set({ error: msg(e) });
        } finally {
          if (get().activeId === id) set({ loadingDetail: false });
        }
      },

      // `detail` is left as-is on purpose: it's the persisted copy that makes
      // the note readable offline the next time it's opened, and the normal
      // way back to it is through the bare notes list — clearing it here would
      // wipe the one thing the offline case depends on before it's ever used.
      closeNote: () => set({ activeId: null }),

      createNote: async (parentId = null, title = "Untitled") => {
        try {
          const res = await api.post<APIResponse<Note>>("/api/v1/notes/", { title, parentId }, true);
          if (!res.success || !res.data) throw new Error(res.error ?? "Failed to create note");
          await get().fetchTree();
          return res.data;
        } catch (e) {
          set({ error: msg(e) });
          return null;
        }
      },

      renameNote: async (id, title) => {
        await api.patch<APIResponse<Note>>(`/api/v1/notes/${id}`, { title });
        await get().fetchTree();
        if (get().activeId === id) await get().openNote(id);
      },

      saveBody: async (id, body) => {
        const res = await api.patch<APIResponse<Note>>(`/api/v1/notes/${id}`, { body });
        if (res.success && res.data && get().activeId === id) {
          set((s) => ({
            detail: s.detail ? { ...s.detail, note: res.data! } : s.detail,
            savedAt: Date.now(),
          }));
        }
        // hasBody may have just flipped; keep the tree's dot in sync.
        await get().fetchTree();
      },

      deleteNote: async (id) => {
        const res = await api.delete<APIResponse<{ deleted: number }>>(`/api/v1/notes/${id}`);
        if (get().activeId === id || get().descendantsOf(id).includes(get().activeId ?? "")) {
          set({ activeId: null, detail: null });
        }
        await get().fetchTree();
        return res.success && res.data ? res.data.deleted : 0;
      },

      descendantsOf: (id) => {
        const tree = get().tree;
        const childrenOf = new Map<string, string[]>();
        for (const n of tree) {
          const key = n.parentId ?? "";
          childrenOf.set(key, [...(childrenOf.get(key) ?? []), n.id]);
        }
        const out: string[] = [];
        const walk = (nodeId: string) => {
          out.push(nodeId);
          for (const child of childrenOf.get(nodeId) ?? []) walk(child);
        };
        walk(id);
        return out;
      },

      moveTree: async (moves) => {
        // Optimistic: the navigator already rendered the drop, so apply it to
        // the local tree immediately and only revert on a real failure.
        const prev = get().tree;
        const byId = new Map(moves.map((m) => [m.id, m]));
        set({
          tree: prev.map((n) =>
            byId.has(n.id) ? { ...n, parentId: byId.get(n.id)!.parentId, position: byId.get(n.id)!.position } : n,
          ),
        });
        try {
          await api.put<APIResponse<unknown>>("/api/v1/notes/tree", moves);
        } catch (e) {
          set({ tree: prev, error: msg(e) });
        }
      },

      search: async (query) => {
        set({ searchQuery: query });
        if (!query.trim()) {
          set({ searchResults: [], searching: false });
          return;
        }
        set({ searching: true });
        try {
          const res = await api.get<APIResponse<NoteSearchResult[]>>(
            `/api/v1/notes/search?q=${encodeURIComponent(query)}`,
          );
          set({ searchResults: res.success && res.data ? res.data : [] });
        } catch {
          // Offline: fall back to the persisted tree's titles — no server
          // round trip needed for a title match, which covers most searches.
          const q = query.toLowerCase();
          set({
            searchResults: get()
              .tree.filter((n) => n.title.toLowerCase().includes(q))
              .slice(0, 40)
              .map((n) => ({ id: n.id, title: n.title, excerpt: "" })),
          });
        } finally {
          set({ searching: false });
        }
      },

      clearSearch: () => set({ searchQuery: "", searchResults: [] }),

      findNotes: async (query) => {
        if (!query.trim()) return [];
        try {
          const res = await api.get<APIResponse<NoteSearchResult[]>>(
            `/api/v1/notes/search?q=${encodeURIComponent(query)}`,
          );
          return res.success && res.data ? res.data : [];
        } catch {
          const q = query.toLowerCase();
          return get()
            .tree.filter((n) => n.title.toLowerCase().includes(q))
            .slice(0, 40)
            .map((n) => ({ id: n.id, title: n.title, excerpt: "" }));
        }
      },

      uploadAttachment: async (file) => {
        const noteId = get().detail?.note.id;
        if (!noteId) {
          set({ error: "Open a note before attaching files" });
          return null;
        }
        const form = new FormData();
        form.append("file", file);
        try {
          const res = await api.postForm<APIResponse<NoteAttachment>>(
            `/api/v1/notes/${noteId}/attachments`,
            form,
          );
          if (!res.success || !res.data) throw new Error(res.error ?? "Upload failed");
          return { url: res.data.url, fileName: res.data.fileName };
        } catch (e) {
          set({ error: msg(e) });
          return null;
        }
      },
    }),
    {
      name: "cac-notes",
      // Only the tree and the last-open note's detail are worth persisting:
      // that's what makes the sidebar and the open page readable without a
      // network round trip. Search results and transient UI state are not.
      partialize: (s) => ({ tree: s.tree, activeId: s.activeId, detail: s.detail }),
    },
  ),
);
