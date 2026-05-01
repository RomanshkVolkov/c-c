import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export interface RequestNode {
  id: string;
  type: "request";
  parentId: string | null;
  name: string;
  method: string;
  url: string;
  headers: KeyValue[];
  body: string;
}

export interface FolderNode {
  id: string;
  type: "folder";
  parentId: string | null;
  name: string;
  expanded: boolean;
}

export type RequestTreeNode = RequestNode | FolderNode;

export interface HttpResponse {
  status: number;
  status_text: string;
  headers: KeyValue[];
  body: string;
  size_bytes: number;
  elapsed_ms: number;
}

const newId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const defaultRequest = (parentId: string | null): RequestNode => ({
  id: newId(),
  type: "request",
  parentId,
  name: "Untitled Request",
  method: "GET",
  url: "",
  headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
  body: "",
});

const defaultFolder = (parentId: string | null): FolderNode => ({
  id: newId(),
  type: "folder",
  parentId,
  name: "New Folder",
  expanded: true,
});

interface RequestsState {
  nodes: RequestTreeNode[];
  activeRequestId: string | null;
  responses: Record<string, HttpResponse>;
  errors: Record<string, string>;

  createFolder: (parentId: string | null) => string;
  createRequest: (parentId: string | null) => string;
  updateRequest: (
    id: string,
    patch: Partial<Omit<RequestNode, "id" | "type" | "parentId">>,
  ) => void;
  renameNode: (id: string, name: string) => void;
  deleteNode: (id: string) => void;
  toggleFolder: (id: string) => void;
  setActiveRequest: (id: string | null) => void;
  duplicateRequest: (id: string) => void;
  setResponse: (id: string, response: HttpResponse | null) => void;
  setError: (id: string, error: string | null) => void;
}

export const useRequestsStore = create<RequestsState>()(
  persist(
    (set, get) => ({
      nodes: [],
      activeRequestId: null,
      responses: {},
      errors: {},

      createFolder: (parentId) => {
        const folder = defaultFolder(parentId);
        set((s) => {
          const nodes = [...s.nodes, folder];
          if (parentId) {
            return {
              nodes: nodes.map((n) =>
                n.id === parentId && n.type === "folder"
                  ? { ...n, expanded: true }
                  : n,
              ),
            };
          }
          return { nodes };
        });
        return folder.id;
      },

      createRequest: (parentId) => {
        const req = defaultRequest(parentId);
        set((s) => {
          const nodes = [...s.nodes, req];
          if (parentId) {
            return {
              nodes: nodes.map((n) =>
                n.id === parentId && n.type === "folder"
                  ? { ...n, expanded: true }
                  : n,
              ),
              activeRequestId: req.id,
            };
          }
          return { nodes, activeRequestId: req.id };
        });
        return req.id;
      },

      updateRequest: (id, patch) => {
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id && n.type === "request" ? { ...n, ...patch } : n,
          ),
        }));
      },

      renameNode: (id, name) => {
        set((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, name } : n)),
        }));
      },

      deleteNode: (id) => {
        set((s) => {
          const toDelete = new Set<string>();
          const collect = (nid: string) => {
            toDelete.add(nid);
            for (const n of s.nodes) {
              if (n.parentId === nid) collect(n.id);
            }
          };
          collect(id);
          const nodes = s.nodes.filter((n) => !toDelete.has(n.id));
          const activeRequestId =
            s.activeRequestId && toDelete.has(s.activeRequestId)
              ? null
              : s.activeRequestId;
          const responses = { ...s.responses };
          const errors = { ...s.errors };
          for (const did of toDelete) {
            delete responses[did];
            delete errors[did];
          }
          return { nodes, activeRequestId, responses, errors };
        });
      },

      toggleFolder: (id) => {
        set((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id && n.type === "folder"
              ? { ...n, expanded: !n.expanded }
              : n,
          ),
        }));
      },

      setActiveRequest: (id) => set({ activeRequestId: id }),

      duplicateRequest: (id) => {
        const original = get().nodes.find((n) => n.id === id);
        if (!original || original.type !== "request") return;
        const dup: RequestNode = {
          ...original,
          id: newId(),
          name: `${original.name} (copy)`,
        };
        set((s) => ({ nodes: [...s.nodes, dup], activeRequestId: dup.id }));
      },

      setResponse: (id, response) => {
        set((s) => {
          const responses = { ...s.responses };
          if (response) responses[id] = response;
          else delete responses[id];
          return { responses };
        });
      },

      setError: (id, error) => {
        set((s) => {
          const errors = { ...s.errors };
          if (error) errors[id] = error;
          else delete errors[id];
          return { errors };
        });
      },
    }),
    {
      name: "cac-requests",
      partialize: (s) => ({
        nodes: s.nodes,
        activeRequestId: s.activeRequestId,
      }),
    },
  ),
);
