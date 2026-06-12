import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  CollectionDetail,
  CollectionMeta,
  ShareInfo,
} from "@/types/collections";
import type { KeyValue, RequestNode, RequestTreeNode } from "@/store/requests.store";

const SAVE_DEBOUNCE_MS = 600;

const newId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

// Module-level debounce timers — one per collection. Kept outside zustand state
// so updating them doesn't trigger re-renders.
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

// Backend serializes request nodes with json:",omitempty" historically, so
// empty fields are missing in the response. Fill them in defensively so
// renderers can safely call .url.trim() / .headers.map() etc.
function normalizeTreeNodes(nodes: RequestTreeNode[]): RequestTreeNode[] {
  return nodes.map((n) => {
    if (n.type !== "request") return n;
    const r = n as Partial<RequestNode> & RequestTreeNode;
    return {
      ...r,
      method: r.method ?? "GET",
      url: r.url ?? "",
      headers: Array.isArray(r.headers) ? r.headers : [],
      body: r.body ?? "",
    } as RequestNode;
  });
}

interface CollectionsState {
  collections: CollectionMeta[];
  loading: boolean;
  error: string | null;

  treeNodes: Record<string, RequestTreeNode[]>;
  treeLoading: Record<string, boolean>;
  treeError: Record<string, string | null>;
  expandedCollections: Record<string, boolean>;

  // Per-collection save state for the autosave indicator.
  savingCollections: Record<string, boolean>;
  saveErrors: Record<string, string | null>;
  lastSavedAt: Record<string, number>;

  // Active remote selection
  activeCollectionId: string | null;
  activeRequestId: string | null;

  // Reads
  fetchCollections: () => Promise<void>;
  loadTree: (collectionId: string, force?: boolean) => Promise<void>;
  toggleCollectionExpanded: (id: string) => void;
  toggleRemoteFolder: (collectionId: string, nodeId: string) => void;
  setActive: (collectionId: string, requestId: string) => void;
  clearActive: () => void;

  // Writes — collection level
  createCollection: (name: string, description?: string) => Promise<CollectionMeta>;
  deleteCollection: (id: string) => Promise<void>;
  renameCollection: (id: string, name: string) => Promise<void>;

  // Writes — tree mutations (optimistic, debounced PUT)
  addRemoteRequest: (collectionId: string, parentId: string | null) => string;
  addRemoteFolder: (collectionId: string, parentId: string | null) => string;
  updateRemoteRequest: (
    collectionId: string,
    requestId: string,
    patch: Partial<Omit<RequestNode, "id" | "type" | "parentId">>,
  ) => void;
  renameRemoteNode: (collectionId: string, nodeId: string, name: string) => void;
  deleteRemoteNode: (collectionId: string, nodeId: string) => void;
  duplicateRemoteRequest: (collectionId: string, requestId: string) => void;

  // Save plumbing
  scheduleSave: (collectionId: string) => void;
  flushSave: (collectionId: string) => Promise<void>;

  // Promote a local tree to a brand-new remote collection.
  promoteToRemote: (name: string, nodes: RequestTreeNode[]) => Promise<CollectionMeta>;

  // Shares
  listShares: (id: string) => Promise<ShareInfo[]>;
  share: (id: string, username: string, permission: "read" | "write") => Promise<ShareInfo>;
  unshare: (id: string, userId: string) => Promise<void>;
}

export const useCollectionsStore = create<CollectionsState>()((set, get) => ({
  collections: [],
  loading: false,
  error: null,
  treeNodes: {},
  treeLoading: {},
  treeError: {},
  expandedCollections: {},
  savingCollections: {},
  saveErrors: {},
  lastSavedAt: {},
  activeCollectionId: null,
  activeRequestId: null,

  fetchCollections: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<APIResponse<CollectionMeta[]>>(
        "/api/v1/collections/",
        true,
      );
      if (!res.success) throw new Error(res.error ?? "Failed to load");
      set({ collections: res.data ?? [] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  loadTree: async (collectionId, force = false) => {
    if (!force && get().treeNodes[collectionId]) return;
    set((s) => ({
      treeLoading: { ...s.treeLoading, [collectionId]: true },
      treeError: { ...s.treeError, [collectionId]: null },
    }));
    try {
      const res = await api.get<APIResponse<CollectionDetail>>(
        `/api/v1/collections/${collectionId}`,
        true,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load tree");
      set((s) => ({
        treeNodes: { ...s.treeNodes, [collectionId]: normalizeTreeNodes(res.data!.nodes) },
        collections: s.collections.map((c) =>
          c.id === collectionId ? { ...c, ...res.data!.collection } : c,
        ),
      }));
    } catch (e) {
      set((s) => ({
        treeError: {
          ...s.treeError,
          [collectionId]: e instanceof Error ? e.message : String(e),
        },
      }));
    } finally {
      set((s) => ({
        treeLoading: { ...s.treeLoading, [collectionId]: false },
      }));
    }
  },

  toggleCollectionExpanded: (id) => {
    const wasExpanded = get().expandedCollections[id] ?? false;
    const willExpand = !wasExpanded;
    set((s) => ({
      expandedCollections: { ...s.expandedCollections, [id]: willExpand },
    }));
    if (willExpand && !get().treeNodes[id] && !get().treeLoading[id]) {
      void get().loadTree(id);
    }
  },

  toggleRemoteFolder: (collectionId, nodeId) => {
    set((s) => {
      const nodes = s.treeNodes[collectionId];
      if (!nodes) return s;
      return {
        treeNodes: {
          ...s.treeNodes,
          [collectionId]: nodes.map((n) =>
            n.id === nodeId && n.type === "folder"
              ? { ...n, expanded: !n.expanded }
              : n,
          ),
        },
      };
    });
  },

  setActive: (collectionId, requestId) =>
    set({ activeCollectionId: collectionId, activeRequestId: requestId }),

  clearActive: () => set({ activeCollectionId: null, activeRequestId: null }),

  // ─── Collection-level writes ───────────────────────────────────────────

  createCollection: async (name, description = "") => {
    const res = await api.post<APIResponse<CollectionMeta>>(
      "/api/v1/collections/",
      { name, description },
      true,
    );
    if (!res.success || !res.data) throw new Error(res.error ?? "Create failed");
    set((s) => ({
      collections: [res.data!, ...s.collections],
      treeNodes: { ...s.treeNodes, [res.data!.id]: [] },
    }));
    return res.data;
  },

  deleteCollection: async (id) => {
    const res = await api.delete<APIResponse<unknown>>(
      `/api/v1/collections/${id}`,
    );
    if (!res.success) throw new Error(res.error ?? "Delete failed");
    set((s) => {
      const drop = <T>(rec: Record<string, T>) => {
        const copy = { ...rec };
        delete copy[id];
        return copy;
      };
      const cleared = s.activeCollectionId === id;
      return {
        collections: s.collections.filter((c) => c.id !== id),
        treeNodes: drop(s.treeNodes),
        treeLoading: drop(s.treeLoading),
        treeError: drop(s.treeError),
        expandedCollections: drop(s.expandedCollections),
        savingCollections: drop(s.savingCollections),
        saveErrors: drop(s.saveErrors),
        lastSavedAt: drop(s.lastSavedAt),
        activeCollectionId: cleared ? null : s.activeCollectionId,
        activeRequestId: cleared ? null : s.activeRequestId,
      };
    });
  },

  renameCollection: async (id, name) => {
    const current = get().collections.find((c) => c.id === id);
    const description = current?.description ?? "";
    // Optimistic update
    set((s) => ({
      collections: s.collections.map((c) => (c.id === id ? { ...c, name } : c)),
    }));
    try {
      const res = await api.put<APIResponse<CollectionMeta>>(
        `/api/v1/collections/${id}`,
        { name, description },
        true,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? "Rename failed");
      set((s) => ({
        collections: s.collections.map((c) =>
          c.id === id ? { ...c, ...res.data! } : c,
        ),
      }));
    } catch (e) {
      // Revert
      if (current) {
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === id ? { ...c, name: current.name } : c,
          ),
        }));
      }
      throw e;
    }
  },

  // ─── Tree-level writes (optimistic, debounced) ──────────────────────────

  addRemoteRequest: (collectionId, parentId) => {
    const id = newId();
    const node: RequestNode = {
      id,
      type: "request",
      parentId,
      name: "Untitled Request",
      method: "GET",
      url: "",
      headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
      body: "",
    };
    set((s) => {
      const existing = s.treeNodes[collectionId] ?? [];
      const expandParent =
        parentId !== null
          ? existing.map((n) =>
              n.id === parentId && n.type === "folder" ? { ...n, expanded: true } : n,
            )
          : existing;
      return {
        treeNodes: { ...s.treeNodes, [collectionId]: [...expandParent, node] },
        expandedCollections: {
          ...s.expandedCollections,
          [collectionId]: true,
        },
        activeCollectionId: collectionId,
        activeRequestId: id,
      };
    });
    get().scheduleSave(collectionId);
    return id;
  },

  addRemoteFolder: (collectionId, parentId) => {
    const id = newId();
    const node = {
      id,
      type: "folder" as const,
      parentId,
      name: "New Folder",
      expanded: true,
    };
    set((s) => {
      const existing = s.treeNodes[collectionId] ?? [];
      const expandParent =
        parentId !== null
          ? existing.map((n) =>
              n.id === parentId && n.type === "folder" ? { ...n, expanded: true } : n,
            )
          : existing;
      return {
        treeNodes: { ...s.treeNodes, [collectionId]: [...expandParent, node] },
        expandedCollections: { ...s.expandedCollections, [collectionId]: true },
      };
    });
    get().scheduleSave(collectionId);
    return id;
  },

  updateRemoteRequest: (collectionId, requestId, patch) => {
    set((s) => {
      const nodes = s.treeNodes[collectionId];
      if (!nodes) return s;
      return {
        treeNodes: {
          ...s.treeNodes,
          [collectionId]: nodes.map((n) =>
            n.id === requestId && n.type === "request" ? { ...n, ...patch } : n,
          ),
        },
      };
    });
    get().scheduleSave(collectionId);
  },

  renameRemoteNode: (collectionId, nodeId, name) => {
    set((s) => {
      const nodes = s.treeNodes[collectionId];
      if (!nodes) return s;
      return {
        treeNodes: {
          ...s.treeNodes,
          [collectionId]: nodes.map((n) => (n.id === nodeId ? { ...n, name } : n)),
        },
      };
    });
    get().scheduleSave(collectionId);
  },

  deleteRemoteNode: (collectionId, nodeId) => {
    set((s) => {
      const nodes = s.treeNodes[collectionId];
      if (!nodes) return s;
      const toDelete = new Set<string>();
      const collect = (id: string) => {
        toDelete.add(id);
        for (const n of nodes) if (n.parentId === id) collect(n.id);
      };
      collect(nodeId);
      const cleared =
        s.activeCollectionId === collectionId &&
        s.activeRequestId !== null &&
        toDelete.has(s.activeRequestId);
      return {
        treeNodes: {
          ...s.treeNodes,
          [collectionId]: nodes.filter((n) => !toDelete.has(n.id)),
        },
        activeCollectionId: cleared ? null : s.activeCollectionId,
        activeRequestId: cleared ? null : s.activeRequestId,
      };
    });
    get().scheduleSave(collectionId);
  },

  duplicateRemoteRequest: (collectionId, requestId) => {
    const nodes = get().treeNodes[collectionId];
    if (!nodes) return;
    const original = nodes.find((n) => n.id === requestId);
    if (!original || original.type !== "request") return;
    const dup: RequestNode = {
      ...original,
      id: newId(),
      name: `${original.name} (copy)`,
    };
    set((s) => ({
      treeNodes: {
        ...s.treeNodes,
        [collectionId]: [...(s.treeNodes[collectionId] ?? []), dup],
      },
      activeCollectionId: collectionId,
      activeRequestId: dup.id,
    }));
    get().scheduleSave(collectionId);
  },

  // ─── Save plumbing ────────────────────────────────────────────────────

  scheduleSave: (collectionId) => {
    if (saveTimers[collectionId]) clearTimeout(saveTimers[collectionId]);
    saveTimers[collectionId] = setTimeout(() => {
      delete saveTimers[collectionId];
      void get().flushSave(collectionId);
    }, SAVE_DEBOUNCE_MS);
  },

  flushSave: async (collectionId) => {
    const nodes = get().treeNodes[collectionId];
    if (!nodes) return;
    set((s) => ({
      savingCollections: { ...s.savingCollections, [collectionId]: true },
      saveErrors: { ...s.saveErrors, [collectionId]: null },
    }));
    try {
      const res = await api.put<APIResponse<RequestTreeNode[]>>(
        `/api/v1/collections/${collectionId}/tree`,
        { nodes },
        true,
      );
      if (!res.success) throw new Error(res.error ?? "Save failed");
      set((s) => ({
        // Trust the server's return as the new canonical tree
        treeNodes: { ...s.treeNodes, [collectionId]: res.data ?? nodes },
        lastSavedAt: { ...s.lastSavedAt, [collectionId]: Date.now() },
        // Also bump updatedAt locally so the sidebar list reorders
        collections: s.collections.map((c) =>
          c.id === collectionId
            ? { ...c, updatedAt: new Date().toISOString() }
            : c,
        ),
      }));
    } catch (e) {
      set((s) => ({
        saveErrors: {
          ...s.saveErrors,
          [collectionId]: e instanceof Error ? e.message : String(e),
        },
      }));
    } finally {
      set((s) => ({
        savingCollections: { ...s.savingCollections, [collectionId]: false },
      }));
    }
  },

  promoteToRemote: async (name, nodes) => {
    // 1) Create empty remote collection.
    const meta = await get().createCollection(name);
    // 2) Push the local tree as the remote tree (give every node a fresh id
    //    to avoid colliding with anything; preserve parent relations via map).
    const idMap = new Map<string, string>();
    const cloned: RequestTreeNode[] = nodes.map((n) => {
      const newNodeId = newId();
      idMap.set(n.id, newNodeId);
      return n.type === "folder"
        ? { ...n, id: newNodeId }
        : { ...n, id: newNodeId };
    });
    for (const n of cloned) {
      if (n.parentId !== null) {
        n.parentId = idMap.get(n.parentId) ?? null;
      }
    }
    set((s) => ({ treeNodes: { ...s.treeNodes, [meta.id]: cloned } }));
    await get().flushSave(meta.id);
    return meta;
  },

  // ─── Shares ───────────────────────────────────────────────────────────

  listShares: async (id) => {
    const res = await api.get<APIResponse<ShareInfo[]>>(
      `/api/v1/collections/${id}/shares`,
      true,
    );
    if (!res.success) throw new Error(res.error ?? "Failed to load shares");
    return res.data ?? [];
  },

  share: async (id, username, permission) => {
    const res = await api.post<APIResponse<ShareInfo>>(
      `/api/v1/collections/${id}/shares`,
      { username, permission },
      true,
    );
    if (!res.success || !res.data) throw new Error(res.error ?? "Share failed");
    return res.data;
  },

  unshare: async (id, userId) => {
    const res = await api.delete<APIResponse<unknown>>(
      `/api/v1/collections/${id}/shares/${userId}`,
    );
    if (!res.success) throw new Error(res.error ?? "Revoke failed");
  },
}));

// Keep KeyValue in scope for type inference of patch args
export type { KeyValue };
