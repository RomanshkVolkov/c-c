import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, apiUrl } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import type { APIResponse } from "@/types/auth";

/** Where a dragged node lands relative to the row it was dropped on. */
export type DropWhere = "before" | "after" | "inside";

/**
 * Enough to move a node: what it is, and what it currently hangs off.
 *
 * The parent travels with the reference because "drop it after this list" has
 * to resolve to a container, and the tree already knows which one — asking the
 * server again would be a round-trip for something on screen.
 */
export interface TreeNodeRef {
  id: string;
  kind: "folder" | "list";
  /** The folder it sits in; null means directly under the space. */
  parentId: string | null;
}
import type {
  TaskStatusKind,
  BoardResponse,
  SpaceTree,
  TaskCard,
  TaskDetail,
  TaskTag,
  ItemVisibility,
  Doc,
  DocAttachment,
  DocOwnerKind,
  DocResponse,
  UpdateTaskPayload,
  TaskPriority,
  TaskStatus,
} from "@/types/task";
import type { CreateReportProjectResult, ReportProject } from "@/types/report";

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
  /** Returns the new folder's id, which is what lets `Tab` nest under it. */
  createFolder: (spaceId: string, name: string, parentFolderId?: string) => Promise<string | undefined>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  createList: (spaceId: string, name: string, folderId?: string) => Promise<void>;
  renameList: (id: string, name: string) => Promise<void>;
  deleteList: (id: string) => Promise<void>;

  moveSpace: (id: string, dir: "up" | "down") => Promise<void>;
  moveFolder: (id: string, dir: "up" | "down") => Promise<void>;
  /**
   * Drag-and-drop in the tree: drop `dragged` before/after `target`, or inside
   * it when the target is a folder.
   *
   * The server has taken neighbours rather than a position all along — the same
   * shape `moveTask` uses — so a drop is one row updated, not every sibling
   * after it renumbered.
   */
  dropNode: (dragged: TreeNodeRef, target: TreeNodeRef, where: DropWhere) => Promise<void>;
  duplicateFolder: (id: string, name?: string) => Promise<void>;
  /**
   * Alphabetical order for one container's children.
   *
   * One request rather than a move per child: a sort that half-applied would
   * leave a tree that is neither the old order nor the new one, and the server
   * decides the order so there is no way to ask for one that isn't sorted.
   */
  sortChildren: (kind: "space" | "folder", id: string) => Promise<void>;
  moveFolderToSpace: (id: string, spaceId: string) => Promise<void>;
  moveListToSpace: (id: string, spaceId: string) => Promise<void>;
  createSubtask: (parentId: string, title: string) => Promise<void>;

  /**
   * The columns of one list, whichever list that is.
   *
   * The detail used to read `board.statuses`, which is the columns of the board
   * that happens to be open — so opening a task from "my work" or from a
   * notification offered an empty menu and no way to change its state. They are
   * asked for by list because that is what they belong to.
   */
  statusesOf: (listId: string) => Promise<TaskStatus[]>;
  createStatus: (name: string, color: string, kind: TaskStatusKind) => Promise<void>;
  updateStatus: (id: string, name: string, color: string, kind: TaskStatusKind) => Promise<void>;
  moveStatus: (id: string, afterId: string, beforeId: string) => Promise<void>;
  deleteStatus: (id: string, moveToId: string) => Promise<void>;

  createTask: (
    title: string,
    statusId?: string,
    visibility?: ItemVisibility,
    /** Markdown body, for callers that have more than a title — chat→task does. */
    description?: string,
  ) => Promise<void>;
  /**
   * Raise a task anywhere, with everything decided up front.
   *
   * Separate from `createTask`, which raises one in the board you are looking
   * at. This one is told where to put it, so "my work" can create without
   * navigating — and it sends the date and the people in the same request,
   * because a task that exists for a moment with nobody on it and no date is
   * visible to everyone watching and wrong while it lasts.
   */
  createTaskIn: (input: {
    listId: string;
    title: string;
    priority?: TaskPriority;
    dueAt?: string | null;
    assigneeIds?: string[];
    visibility?: ItemVisibility;
  }) => Promise<void>;
  moveTask: (taskId: string, statusId: string, afterId: string, beforeId: string) => Promise<void>;
  openTask: (id: string) => Promise<void>;
  /** Re-read the open task without unmounting the drawer. See the impl. */
  refreshOpenTask: () => Promise<void>;
  closeTask: () => void;
  updateTask: (id: string, patch: UpdateTaskPayload) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  addComment: (taskId: string, body: string, visibility?: ItemVisibility) => Promise<void>;
  editComment: (taskId: string, commentId: string, body: string) => Promise<void>;
  deleteComment: (taskId: string, commentId: string) => Promise<void>;
  uploadAttachment: (taskId: string, file: File) => Promise<{ url: string; fileName: string } | null>;
  deleteAttachment: (taskId: string, attachmentId: string) => Promise<void>;
  createTag: (orgId: string, name: string, color: string) => Promise<TaskTag | null>;

  // ── The channel a space or list belongs to ──
  //
  // Two separate things, and conflating them is how you end up with a list bound
  // to a client whose settings nobody can reach: *binding* says which channel a
  // node belongs to, *configuring* changes how that channel behaves.
  bindNode: (kind: ChannelOwner, id: string, name: string, projectId: string) => Promise<void>;
  fetchChannel: (kind: ChannelOwner, id: string) => Promise<ReportProject | null>;
  createChannel: (spaceId: string, req: NewChannel) => Promise<CreateReportProjectResult | null>;
  updateChannel: (kind: ChannelOwner, id: string, req: ChannelPatch) => Promise<void>;
  rotateChannelKey: (kind: ChannelOwner, id: string) => Promise<string>;
  /**
   * Every channel of the current organization, for the picker that binds a node
   * to one that already exists.
   *
   * Here rather than on a reports store because the tree is where channels are
   * managed now, and a list of clients is not a fact about the reports screen.
   */
  channels: ReportProject[];
  fetchChannels: () => Promise<void>;
  /** Stop accepting new reports without destroying anything already filed. */
  setChannelActive: (projectId: string, isActive: boolean) => Promise<void>;
  deleteChannel: (projectId: string) => Promise<void>;

  // ── Docs: one markdown overview per space/folder/list ──
  /** Which nodes carry a document, keyed `kind:id` — drives the navigator mark. */
  docIndex: Record<string, boolean>;
  /** The node whose overview is on screen; null when a board is. */
  activeDoc: { kind: DocOwnerKind; id: string; name: string } | null;
  doc: DocResponse | null;
  loadingDoc: boolean;
  fetchDocIndex: () => Promise<void>;
  openDoc: (kind: DocOwnerKind, id: string, name: string) => Promise<void>;
  closeDoc: () => void;
  saveDoc: (body: string) => Promise<void>;
  uploadDocAttachment: (file: File) => Promise<{ url: string; fileName: string } | null>;
}

/** Which node owns the binding. Folders can't: the backend has no such column. */
export type ChannelOwner = "space" | "list";

const channelBase = (kind: ChannelOwner, id: string) =>
  kind === "space" ? `/api/v1/task-spaces/${id}` : `/api/v1/task-lists/${id}`;

/** What opening a channel needs. The space supplies the org and the name. */
export interface NewChannel {
  name?: string;
  platform: "web" | "app";
  allowedOrigins?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
}

/**
 * A change to a channel's rules.
 *
 * `webhookSecret` is absent unless a new one was typed: the server only replaces
 * it when one arrives, and sending an empty string would clear a secret nobody
 * asked to remove.
 */
export interface ChannelPatch {
  name: string;
  allowedOrigins?: string[];
  rateLimitPerHour?: number;
  rateLimitPerReporterPerHour?: number;
  webhookUrl?: string;
  webhookSecret?: string;
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
      docIndex: {},
      activeDoc: null,
      doc: null,
      loadingDoc: false,
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
        // Picking a list means "show me the board" — leave any open document.
        set({ activeListId: listId, board: null, activeDoc: null, doc: null });
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
      createFolder: async (spaceId, name, parentFolderId) => {
        const res = await api.post<APIResponse<{ id: string }>>(
          `/api/v1/task-spaces/${spaceId}/folders`,
          { name, parentFolderId: parentFolderId ?? null },
          true,
        );
        await get().fetchTree();
        return res.data?.id;
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

      dropNode: async (dragged, target, where) => {
        // "inside" means the target becomes the parent; before/after make them
        // siblings, so the parent is the target's own.
        const parent = where === "inside" ? target.id : target.parentId;
        const body: Record<string, unknown> = { folderId: parent ?? null };
        if (where === "before") body.beforeId = target.id;
        if (where === "after") body.afterId = target.id;
        const base = dragged.kind === "folder" ? "task-folders" : "task-lists";
        await api.post<APIResponse<unknown>>(`/api/v1/${base}/${dragged.id}/move`, body, true);
        await get().fetchTree();
      },

      sortChildren: async (kind, id) => {
        const base = kind === "space" ? "task-spaces" : "task-folders";
        await api.post<APIResponse<unknown>>(`/api/v1/${base}/${id}/sort`, {}, true);
        await get().fetchTree();
      },

      duplicateFolder: async (id, name) => {
        await api.post<APIResponse<unknown>>(`/api/v1/task-folders/${id}/duplicate`, { name: name ?? "" }, true);
        await get().fetchTree();
      },
      moveFolderToSpace: async (id, spaceId) => {
        await api.post<APIResponse<unknown>>(`/api/v1/task-folders/${id}/move-to-space`, { spaceId }, true);
        await get().fetchTree();
      },
      moveListToSpace: async (id, spaceId) => {
        await api.post<APIResponse<unknown>>(`/api/v1/task-lists/${id}/move-to-space`, { spaceId }, true);
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
        if (get().openTaskId === parentId) await get().refreshOpenTask();
        await get().refreshBoard();
      },

      // ─── Columns ────────────────────────────────────────────────────────

      statusesOf: async (listId) => {
        const res = await api.get<APIResponse<TaskStatus[]>>(
          `/api/v1/task-lists/${listId}/statuses`,
          true,
        );
        return res.data ?? [];
      },

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

      createTask: async (title, statusId, visibility, description) => {
        const listId = get().activeListId;
        if (!listId) return;
        await api.post<APIResponse<unknown>>(
          `/api/v1/task-lists/${listId}/tasks`,
          // visibility is sent only when a choice was made. Omitting it lets the
          // server apply its default, which is "the client sees it" — the rule
          // this app must not quietly contradict.
          {
            title,
            statusId: statusId ?? "",
            ...(visibility ? { visibility } : {}),
            ...(description ? { description } : {}),
          },
          true,
        );
        await get().refreshBoard();
        await get().fetchTree(); // list counts
      },

      createTaskIn: async ({ listId, title, priority, dueAt, assigneeIds, visibility }) => {
        await api.post<APIResponse<unknown>>(
          `/api/v1/task-lists/${listId}/tasks`,
          {
            title,
            ...(priority ? { priority } : {}),
            ...(dueAt ? { dueAt } : {}),
            ...(assigneeIds?.length ? { assigneeIds } : {}),
            // Same rule as createTask: sent only when a choice was made, so the
            // server's default — the client sees it — is never contradicted by
            // accident.
            ...(visibility ? { visibility } : {}),
          },
          true,
        );
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

      /**
       * Re-read the open task and swap it in place.
       *
       * Deliberately NOT openTask: that one blanks `detail` before fetching,
       * which unmounts the drawer's whole body — and with it any description
       * or comment being written. A subtask created mid-sentence used to take
       * the sentence with it.
       */
      refreshOpenTask: async () => {
        const id = get().openTaskId;
        if (!id) return;
        try {
          const res = await api.get<APIResponse<TaskDetail>>(`/api/v1/tasks/${id}`);
          if (get().openTaskId !== id) return;
          if (res.success && res.data) set({ detail: res.data });
        } catch (e) {
          set({ error: msg(e) });
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

      addComment: async (taskId, body, visibility) => {
        const res = await api.post<APIResponse<TaskDetail>>(
          `/api/v1/tasks/${taskId}/comments`,
          // Sent only when a choice was made, like createTask: the server's
          // default is "the client reads it too", and inventing a value here
          // would either hide a reply from them or publish a team note.
          { body, ...(visibility ? { visibility } : {}) },
          true,
        );
        if (res.success && res.data && get().openTaskId === taskId) set({ detail: res.data });
        await get().refreshBoard();
      },

      editComment: async (taskId, commentId, body) => {
        await api.patch<APIResponse<unknown>>(
          `/api/v1/tasks/${taskId}/comments/${commentId}`,
          { body },
        );
        await get().refreshOpenTask();
      },

      deleteComment: async (taskId, commentId) => {
        await api.delete<APIResponse<unknown>>(
          `/api/v1/tasks/${taskId}/comments/${commentId}`,
        );
        await get().refreshOpenTask();
        await get().refreshBoard(); // the card shows a comment count
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
          // The Attachments section reads `detail`, so without this the file
          // was on the server and nowhere on screen — which is most of why
          // attaching one looked like it had failed.
          if (get().openTaskId === taskId) void get().refreshOpenTask();
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
        await get().refreshOpenTask();
      },

      fetchDocIndex: async () => {
        const orgId = useOrgsStore.getState().currentOrgId;
        if (!orgId) return;
        try {
          const res = await api.get<APIResponse<Record<string, boolean>>>(
            `/api/v1/docs/?orgId=${orgId}`,
          );
          set({ docIndex: res.success && res.data ? res.data : {} });
        } catch {
          // The mark is decoration; a failure here shouldn't break the navigator.
        }
      },

      openDoc: async (kind, id, name) => {
        // Showing a document replaces the board, so the open task drawer goes too.
        set({ activeDoc: { kind, id, name }, doc: null, loadingDoc: true, openTaskId: null, detail: null });
        try {
          const res = await api.get<APIResponse<DocResponse>>(`/api/v1/docs/${kind}/${id}`);
          if (get().activeDoc?.id !== id) return; // switched away mid-flight
          set({ doc: res.success && res.data ? res.data : null });
        } catch (e) {
          set({ error: msg(e) });
        } finally {
          if (get().activeDoc?.id === id) set({ loadingDoc: false });
        }
      },

      closeDoc: () => set({ activeDoc: null, doc: null }),

      saveDoc: async (body) => {
        const target = get().activeDoc;
        if (!target) return;
        await api.put<APIResponse<Doc>>(`/api/v1/docs/${target.kind}/${target.id}`, { body });
        await get().openDoc(target.kind, target.id, target.name);
        await get().fetchDocIndex(); // the node may have just gained (or lost) its mark
      },

      uploadDocAttachment: async (file) => {
        const doc = get().doc?.doc;
        if (!doc) {
          // Attachments hang off a document row, which only exists once saved.
          set({ error: "Save the overview once before attaching files" });
          return null;
        }
        const form = new FormData();
        form.append("file", file);
        try {
          const res = await api.postForm<APIResponse<DocAttachment>>(
            `/api/v1/docs/${doc.id}/attachments`,
            form,
          );
          if (!res.success || !res.data) throw new Error(res.error ?? "Upload failed");
          return { url: res.data.url, fileName: res.data.fileName };
        } catch (e) {
          set({ error: msg(e) });
          return null;
        }
      },

      // The node keeps its name: this PATCH is the same one that renames, so
      // leaving `name` out would blank it while binding a channel.
      bindNode: async (kind, id, name, projectId) => {
        await api.patch<APIResponse<unknown>>(`${channelBase(kind, id)}`, { name, projectId }, true);
        await get().fetchTree();
      },

      fetchChannel: async (kind, id) => {
        const res = await api.get<APIResponse<ReportProject | null>>(
          `${channelBase(kind, id)}/channel`,
        );
        return res.data ?? null;
      },

      createChannel: async (spaceId, req) => {
        const res = await api.post<APIResponse<CreateReportProjectResult>>(
          `/api/v1/task-spaces/${spaceId}/channel`,
          req,
          true,
        );
        // Opening a channel binds the space, so the tree now draws it differently.
        await get().fetchTree();
        return res.data ?? null;
      },

      updateChannel: async (kind, id, req) => {
        // An empty webhook secret is dropped here rather than by the caller.
        // The server only replaces a secret when one arrives, so sending "" wipes
        // the one that is set — and every webhook the client receives from then
        // on fails its signature check, with nothing on their side pointing back
        // at a form somebody saved without touching that field.
        //
        // In the store because this is the only place that talks to the API: as a
        // caller's discipline it would hold until the second caller.
        const { webhookSecret, ...rest } = req;
        const body = webhookSecret?.trim() ? { ...rest, webhookSecret: webhookSecret.trim() } : rest;
        await api.patch<APIResponse<unknown>>(`${channelBase(kind, id)}/channel`, body, true);
      },

      channels: [],

      fetchChannels: async () => {
        const orgId = useOrgsStore.getState().currentOrgId;
        const res = await api.get<APIResponse<ReportProject[]>>("/api/v1/report-projects/");
        const all = res.data ?? [];
        // Scoped to the org on screen: binding a node to another organization's
        // channel is how work gets pushed at a client nobody here deals with.
        set({ channels: orgId ? all.filter((p) => p.orgId === orgId) : all });
      },

      setChannelActive: async (projectId, isActive) => {
        await api.patch<APIResponse<unknown>>(`/api/v1/report-projects/${projectId}`, { isActive });
        await get().fetchChannels();
      },

      deleteChannel: async (projectId) => {
        await api.delete<APIResponse<unknown>>(`/api/v1/report-projects/${projectId}`);
        await get().fetchChannels();
        // The tree carries the binding, so it goes stale the moment a channel
        // disappears from under a list.
        await get().fetchTree();
      },

      rotateChannelKey: async (kind, id) => {
        const res = await api.post<APIResponse<{ ingestKey: string }>>(
          `${channelBase(kind, id)}/channel/rotate-key`,
          {},
          true,
        );
        return res.data?.ingestKey ?? "";
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
      partialize: (s) => ({ activeListId: s.activeListId, activeDoc: s.activeDoc }),
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
