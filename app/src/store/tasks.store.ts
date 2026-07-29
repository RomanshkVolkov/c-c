import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, apiUrl } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import type { APIResponse } from "@/types/auth";
import type {
  TaskStatusKind,
  BoardResponse,
  SpaceTree,
  TaskCard,
  TaskDetail,
  TaskTag,
  UpdateTaskPayload,
} from "@/types/task";

interface TasksState {
  tree: SpaceTree[];
  tags: TaskTag[];
  loadingTree: boolean;
  error: string | null;

  /** Persisted so reopening the module lands on the list you were using. */
  activeListId: string | null;
  board: BoardResponse | null;
  loadingBoard: boolean;

  openTaskId: string | null;
  detail: TaskDetail | null;
  loadingDetail: boolean;

  fetchTree: () => Promise<void>;
  fetchTags: () => Promise<void>;
  selectList: (listId: string) => Promise<void>;
  refreshBoard: () => Promise<void>;

  createSpace: (orgId: string, name: string) => Promise<void>;
  renameSpace: (id: string, name: string) => Promise<void>;
  deleteSpace: (id: string) => Promise<void>;
  createFolder: (spaceId: string, name: string) => Promise<void>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  createList: (spaceId: string, name: string, folderId?: string) => Promise<void>;
  renameList: (id: string, name: string) => Promise<void>;
  deleteList: (id: string) => Promise<void>;

  moveSpace: (id: string, dir: "up" | "down") => Promise<void>;
  moveFolder: (id: string, dir: "up" | "down") => Promise<void>;
  createSubtask: (parentId: string, title: string) => Promise<void>;

  createStatus: (name: string, color: string, kind: TaskStatusKind) => Promise<void>;
  updateStatus: (id: string, name: string, color: string, kind: TaskStatusKind) => Promise<void>;
  moveStatus: (id: string, afterId: string, beforeId: string) => Promise<void>;
  deleteStatus: (id: string, moveToId: string) => Promise<void>;

  createTask: (title: string, statusId?: string) => Promise<void>;
  moveTask: (taskId: string, statusId: string, afterId: string, beforeId: string) => Promise<void>;
  openTask: (id: string) => Promise<void>;
  closeTask: () => void;
  updateTask: (id: string, patch: UpdateTaskPayload) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  addComment: (taskId: string, body: string) => Promise<void>;
  uploadAttachment: (taskId: string, file: File) => Promise<{ url: string; fileName: string } | null>;
  deleteAttachment: (taskId: string, attachmentId: string) => Promise<void>;
  createTag: (orgId: string, name: string, color: string) => Promise<TaskTag | null>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useTasksStore = create<TasksState>()(
  persist(
    (set, get) => ({
      tree: [],
      tags: [],
      loadingTree: false,
      error: null,
      activeListId: null,
      board: null,
      loadingBoard: false,
      openTaskId: null,
      detail: null,
      loadingDetail: false,

      fetchTree: async () => {
        set({ loadingTree: true, error: null });
        try {
          // Scope to the org selected in the switcher. Without it the navigator
          // showed every org's spaces at once (and every space on the platform
          // for a superadmin), so switching org appeared to do nothing.
          const orgId = useOrgsStore.getState().currentOrgId;
          const res = await api.get<APIResponse<SpaceTree[]>>(
            `/api/v1/task-spaces/${orgId ? `?orgId=${orgId}` : ""}`,
          );
          const tree = res.success && res.data ? res.data : [];
          set({ tree });

          // Keep the persisted selection only while it still exists.
          const ids = new Set(
            tree.flatMap((s) => [
              ...s.lists.map((l) => l.id),
              ...s.folders.flatMap((f) => f.lists.map((l) => l.id)),
            ]),
          );
          const current = get().activeListId;
          if (current && !ids.has(current)) {
            // The persisted selection belongs to another org (or was deleted):
            // drop the board *and* the open drawer, which would otherwise keep
            // showing a task the current org can't see.
            set({ activeListId: null, board: null, openTaskId: null, detail: null });
          }
        } catch (e) {
          set({ error: msg(e) });
        } finally {
          set({ loadingTree: false });
        }
      },

      fetchTags: async () => {
        try {
          const orgId = useOrgsStore.getState().currentOrgId;
          const res = await api.get<APIResponse<TaskTag[]>>(
            `/api/v1/task-tags/${orgId ? `?orgId=${orgId}` : ""}`,
          );
          set({ tags: res.success && res.data ? res.data : [] });
        } catch {
          /* tags are optional decoration; a failure shouldn't block the board */
        }
      },

      selectList: async (listId) => {
        set({ activeListId: listId, board: null });
        await get().refreshBoard();
      },

      refreshBoard: async () => {
        const listId = get().activeListId;
        if (!listId) return;
        set({ loadingBoard: true, error: null });
        try {
          const res = await api.get<APIResponse<BoardResponse>>(
            `/api/v1/task-lists/${listId}/board`,
          );
          // Ignore a late response for a list the user already navigated away from.
          if (get().activeListId !== listId) return;
          set({ board: res.success && res.data ? res.data : null });
        } catch (e) {
          set({ error: msg(e) });
        } finally {
          if (get().activeListId === listId) set({ loadingBoard: false });
        }
      },

      // ─── Tree mutations ─────────────────────────────────────────────────

      createSpace: async (orgId, name) => {
        await api.post<APIResponse<unknown>>("/api/v1/task-spaces/", { orgId, name }, true);
        await get().fetchTree();
      },
      renameSpace: async (id, name) => {
        await api.patch<APIResponse<unknown>>(`/api/v1/task-spaces/${id}`, { name }, true);
        await get().fetchTree();
      },
      deleteSpace: async (id) => {
        await api.delete<APIResponse<unknown>>(`/api/v1/task-spaces/${id}`);
        await get().fetchTree();
      },
      createFolder: async (spaceId, name) => {
        await api.post<APIResponse<unknown>>(`/api/v1/task-spaces/${spaceId}/folders`, { name }, true);
        await get().fetchTree();
      },
      renameFolder: async (id, name) => {
        await api.patch<APIResponse<unknown>>(`/api/v1/task-folders/${id}`, { name }, true);
        await get().fetchTree();
      },
      deleteFolder: async (id) => {
        await api.delete<APIResponse<unknown>>(`/api/v1/task-folders/${id}`);
        await get().fetchTree();
      },
      createList: async (spaceId, name, folderId) => {
        const res = await api.post<APIResponse<{ id: string }>>(
          `/api/v1/task-spaces/${spaceId}/lists`,
          { name, folderId: folderId ?? null },
          true,
        );
        await get().fetchTree();
        if (res.success && res.data?.id) await get().selectList(res.data.id);
      },
      renameList: async (id, name) => {
        await api.patch<APIResponse<unknown>>(`/api/v1/task-lists/${id}`, { name }, true);
        await get().fetchTree();
      },
      deleteList: async (id) => {
        await api.delete<APIResponse<unknown>>(`/api/v1/task-lists/${id}`);
        if (get().activeListId === id) set({ activeListId: null, board: null });
        await get().fetchTree();
      },

      // ─── Tasks ──────────────────────────────────────────────────────────

      // Reordering is expressed as a one-step nudge; the server resolves the
      // neighbours and derives the rank, and ignores it at the edges.
      moveSpace: async (id, dir) => {
        await api.post<APIResponse<unknown>>(`/api/v1/task-spaces/${id}/move?dir=${dir}`, {}, true);
        await get().fetchTree();
      },
      moveFolder: async (id, dir) => {
        await api.post<APIResponse<unknown>>(`/api/v1/task-folders/${id}/move?dir=${dir}`, {}, true);
        await get().fetchTree();
      },

      createSubtask: async (parentId, title) => {
        const listId = get().activeListId;
        if (!listId) return;
        await api.post<APIResponse<unknown>>(
          `/api/v1/task-lists/${listId}/tasks`,
          { title, parentId },
          true,
        );
        // Refresh both: the parent's progress counter lives on the board card.
        if (get().openTaskId === parentId) await get().openTask(parentId);
        await get().refreshBoard();
      },

      // ─── Columns ────────────────────────────────────────────────────────

      createStatus: async (name, color, kind) => {
        const listId = get().activeListId;
        if (!listId) return;
        await api.post<APIResponse<unknown>>(
          `/api/v1/task-lists/${listId}/statuses`,
          { name, color, kind },
          true,
        );
        await get().refreshBoard();
      },

      updateStatus: async (id, name, color, kind) => {
        await api.patch<APIResponse<unknown>>(
          `/api/v1/task-statuses/${id}`,
          { name, color, kind },
          true,
        );
        await get().refreshBoard();
      },

      moveStatus: async (id, afterId, beforeId) => {
        await api.post<APIResponse<unknown>>(
          `/api/v1/task-statuses/${id}/move`,
          { afterId, beforeId },
          true,
        );
        await get().refreshBoard();
      },

      // The server refuses to strand tasks, so the caller must say which column
      // absorbs them.
      deleteStatus: async (id, moveToId) => {
        await api.delete<APIResponse<unknown>>(
          `/api/v1/task-statuses/${id}?moveTo=${encodeURIComponent(moveToId)}`,
        );
        await get().refreshBoard();
      },

      createTask: async (title, statusId) => {
        const listId = get().activeListId;
        if (!listId) return;
        await api.post<APIResponse<unknown>>(
          `/api/v1/task-lists/${listId}/tasks`,
          { title, statusId: statusId ?? "" },
          true,
        );
        await get().refreshBoard();
        await get().fetchTree(); // list counts
      },

      // Optimistic: the card follows the pointer immediately, and the board is
      // reconciled from the server afterwards.
      moveTask: async (taskId, statusId, afterId, beforeId) => {
        const board = get().board;
        if (board) {
          const tasks = [...board.tasks];
          const idx = tasks.findIndex((t) => t.id === taskId);
          if (idx >= 0) {
            const moved: TaskCard = { ...tasks[idx], statusId };
            tasks.splice(idx, 1);
            const at = beforeId
              ? tasks.findIndex((t) => t.id === beforeId)
              : afterId
                ? tasks.findIndex((t) => t.id === afterId) + 1
                : tasks.length;
            tasks.splice(at < 0 ? tasks.length : at, 0, moved);
            set({ board: { ...board, tasks } });
          }
        }
        try {
          await api.post<APIResponse<unknown>>(
            `/api/v1/tasks/${taskId}/move`,
            { statusId, afterId, beforeId },
            true,
          );
        } finally {
          await get().refreshBoard();
        }
      },

      openTask: async (id) => {
        set({ openTaskId: id, loadingDetail: true, detail: null });
        try {
          const res = await api.get<APIResponse<TaskDetail>>(`/api/v1/tasks/${id}`);
          if (get().openTaskId !== id) return;
          set({ detail: res.success && res.data ? res.data : null });
        } catch (e) {
          set({ error: msg(e) });
        } finally {
          if (get().openTaskId === id) set({ loadingDetail: false });
        }
      },

      closeTask: () => set({ openTaskId: null, detail: null }),

      updateTask: async (id, patch) => {
        const res = await api.patch<APIResponse<TaskDetail>>(`/api/v1/tasks/${id}`, patch, true);
        if (res.success && res.data && get().openTaskId === id) set({ detail: res.data });
        await get().refreshBoard();
      },

      deleteTask: async (id) => {
        await api.delete<APIResponse<unknown>>(`/api/v1/tasks/${id}`);
        if (get().openTaskId === id) set({ openTaskId: null, detail: null });
        await get().refreshBoard();
        await get().fetchTree();
      },

      addComment: async (taskId, body) => {
        const res = await api.post<APIResponse<TaskDetail>>(
          `/api/v1/tasks/${taskId}/comments`,
          { body },
          true,
        );
        if (res.success && res.data && get().openTaskId === taskId) set({ detail: res.data });
        await get().refreshBoard();
      },

      // Uploads go through the backend (multipart), which proxies image-service
      // so its API key never reaches the app.
      uploadAttachment: async (taskId, file) => {
        const form = new FormData();
        form.append("file", file);
        try {
          const res = await api.postForm<APIResponse<{ url: string; fileName: string }>>(
            `/api/v1/tasks/${taskId}/attachments`,
            form,
          );
          if (!res.success || !res.data) throw new Error(res.error ?? "Upload failed");
          return { url: absoluteUrl(res.data.url), fileName: res.data.fileName };
        } catch (e) {
          set({ error: msg(e) });
          return null;
        }
      },

      deleteAttachment: async (taskId, attachmentId) => {
        await api.delete<APIResponse<unknown>>(
          `/api/v1/tasks/${taskId}/attachments/${attachmentId}`,
        );
        // The blob stays in storage on purpose (older revisions of the markdown
        // may still reference it); this only drops the row and the listing.
        await get().openTask(taskId);
      },

      createTag: async (orgId, name, color) => {
        const res = await api.post<APIResponse<TaskTag>>(
          "/api/v1/task-tags/",
          { orgId, name, color },
          true,
        );
        if (!res.success || !res.data) return null;
        set((s) => ({ tags: [...s.tags, res.data!] }));
        return res.data;
      },
    }),
    {
      name: "cac-tasks",
      // Only the navigation position is worth persisting; data is always fetched.
      partialize: (s) => ({ activeListId: s.activeListId }),
    },
  ),
);

/** image-service may return a relative path; make it loadable from the webview. */
function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return apiUrl(url.startsWith("/") ? url : `/${url}`);
}

/** Convenience for components that need the org of the active list. */
export function useActiveSpaceOrg(): string | null {
  const tree = useTasksStore((s) => s.tree);
  const activeListId = useTasksStore((s) => s.activeListId);
  if (!activeListId) return null;
  for (const s of tree) {
    if (s.lists.some((l) => l.id === activeListId)) return s.orgId;
    for (const f of s.folders) {
      if (f.lists.some((l) => l.id === activeListId)) return s.orgId;
    }
  }
  return null;
}

// Clearing tasks state on logout keeps another user's board from flashing on the
// next login.
useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) {
    useTasksStore.setState({
      tree: [],
      tags: [],
      board: null,
      detail: null,
      openTaskId: null,
      error: null,
    });
  }
});
