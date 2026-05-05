import { useEffect, useState } from "react";
import {
  Send,
  Plus,
  Trash2,
  Loader2,
  Copy,
  Check,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Cloud,
  CloudUpload,
  Users,
  Lock,
  AlertCircle,
  Share2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { APIResponse } from "@/types/auth";
import {
  useRequestsStore,
  type HttpResponse,
  type KeyValue,
  type RequestNode,
  type RequestTreeNode,
} from "@/store/requests.store";
import { useCollectionsStore } from "@/store/collections.store";
import type {
  CollectionMeta,
  CollectionPermission,
  ShareInfo,
  UserSummary,
} from "@/types/collections";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

const METHOD_COLORS: Record<string, string> = {
  GET: "text-green-500",
  POST: "text-yellow-500",
  PUT: "text-blue-500",
  PATCH: "text-purple-500",
  DELETE: "text-red-500",
  HEAD: "text-muted-foreground",
  OPTIONS: "text-muted-foreground",
};

function statusVariant(status: number): "default" | "secondary" | "destructive" {
  if (status < 300) return "default";
  if (status < 400) return "secondary";
  return "destructive";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function tryFormatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

interface ActiveSelection {
  req: RequestNode;
  source: "local" | "remote";
  collectionId: string | null;
  permission: CollectionPermission;
}

function useActiveRequest(): ActiveSelection | null {
  const localNodes = useRequestsStore((s) => s.nodes);
  const localActiveId = useRequestsStore((s) => s.activeRequestId);
  const remoteCollectionId = useCollectionsStore((s) => s.activeCollectionId);
  const remoteRequestId = useCollectionsStore((s) => s.activeRequestId);
  const remoteTrees = useCollectionsStore((s) => s.treeNodes);
  const collections = useCollectionsStore((s) => s.collections);

  if (remoteCollectionId && remoteRequestId) {
    const tree = remoteTrees[remoteCollectionId] ?? [];
    const found = tree.find((n) => n.id === remoteRequestId);
    if (found && found.type === "request") {
      const meta = collections.find((c) => c.id === remoteCollectionId);
      return {
        req: found,
        source: "remote",
        collectionId: remoteCollectionId,
        permission: meta?.permission ?? "read",
      };
    }
  }
  if (localActiveId) {
    const found = localNodes.find((n) => n.id === localActiveId);
    if (found && found.type === "request") {
      return { req: found, source: "local", collectionId: null, permission: "write" };
    }
  }
  return null;
}

export default function RequestClient() {
  const localNodes = useRequestsStore((s) => s.nodes);
  const createRequest = useRequestsStore((s) => s.createRequest);
  const collections = useCollectionsStore((s) => s.collections);
  const collectionsLoading = useCollectionsStore((s) => s.loading);

  const active = useActiveRequest();

  useEffect(() => {
    if (
      localNodes.length === 0 &&
      collections.length === 0 &&
      !collectionsLoading
    ) {
      createRequest(null);
    }
  }, [localNodes.length, collections.length, collectionsLoading, createRequest]);

  return (
    <div className="flex-1 flex min-h-0">
      <CollectionsSidebar />
      <div className="flex-1 flex flex-col min-h-0">
        {active ? (
          <RequestEditor
            key={`${active.source}:${active.req.id}`}
            req={active.req}
            source={active.source}
            collectionId={active.collectionId}
            permission={active.permission}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                Select a request from the sidebar or create a new one.
              </p>
              <Button size="sm" onClick={() => createRequest(null)}>
                <Plus className="size-3 mr-1" /> New local request
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

function CollectionsSidebar() {
  const fetchCollections = useCollectionsStore((s) => s.fetchCollections);
  const remoteLoading = useCollectionsStore((s) => s.loading);
  const remoteError = useCollectionsStore((s) => s.error);
  const collections = useCollectionsStore((s) => s.collections);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  const owned = collections.filter((c) => c.isOwner);
  const shared = collections.filter((c) => !c.isOwner);

  return (
    <aside className="w-72 shrink-0 border-r flex flex-col bg-muted/10">
      <header className="h-12 flex items-center justify-between px-3 border-b shrink-0">
        <span className="text-sm font-medium">Collections</span>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Refresh remote"
          disabled={remoteLoading}
          onClick={() => {
            void fetchCollections();
          }}
        >
          <RefreshCw className={cn("size-3", remoteLoading && "animate-spin")} />
        </Button>
      </header>
      <div className="flex-1 overflow-auto py-1">
        <LocalSection />
        <OwnedSection items={owned} loading={remoteLoading} error={remoteError} />
        <SharedSection items={shared} loading={remoteLoading} />
      </div>
    </aside>
  );
}

function SectionHeader({
  title,
  icon,
  count,
  actions,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sticky top-0 bg-muted/10 backdrop-blur-sm z-10">
      {icon}
      <span className="flex-1 truncate">{title}</span>
      {count !== undefined && (
        <span className="text-muted-foreground/70 normal-case font-normal">
          {count}
        </span>
      )}
      {actions && <div className="flex gap-0.5">{actions}</div>}
    </div>
  );
}

// ─── Local section ──────────────────────────────────────────────────────────

function LocalSection() {
  const nodes = useRequestsStore((s) => s.nodes);
  const createFolder = useRequestsStore((s) => s.createFolder);
  const createRequest = useRequestsStore((s) => s.createRequest);
  const clearRemote = useCollectionsStore((s) => s.clearActive);
  const promoteToRemote = useCollectionsStore((s) => s.promoteToRemote);

  const rootNodes = nodes.filter((n) => n.parentId === null);

  const handleSyncToCloud = async () => {
    if (nodes.length === 0) {
      toast.info("Nothing to sync — local is empty");
      return;
    }
    const name = window.prompt("Name for the new cloud collection:");
    if (!name || !name.trim()) return;

    const promise = promoteToRemote(name.trim(), nodes);
    const id = toast.loading("Syncing to cloud…");
    try {
      const meta = await promise;
      toast.success(`"${meta.name}" is now in the cloud`, { id });
    } catch (e) {
      toast.error("Sync failed", {
        id,
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <section>
      <SectionHeader
        title="Local"
        icon={<Lock className="size-3" />}
        count={rootNodes.length}
        actions={
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              title="Sync local to cloud"
              onClick={handleSyncToCloud}
            >
              <CloudUpload className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              title="New local folder"
              onClick={() => {
                clearRemote();
                createFolder(null);
              }}
            >
              <FolderPlus className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              title="New local request"
              onClick={() => {
                clearRemote();
                createRequest(null);
              }}
            >
              <Plus className="size-3" />
            </Button>
          </>
        }
      />
      {rootNodes.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No local items.</p>
      ) : (
        rootNodes.map((n) => <LocalTreeItem key={n.id} node={n} depth={0} />)
      )}
    </section>
  );
}

function LocalTreeItem({ node, depth }: { node: RequestTreeNode; depth: number }) {
  const nodes = useRequestsStore((s) => s.nodes);
  const activeRequestId = useRequestsStore((s) => s.activeRequestId);
  const remoteActiveCollection = useCollectionsStore((s) => s.activeCollectionId);
  const setActive = useRequestsStore((s) => s.setActiveRequest);
  const toggleFolder = useRequestsStore((s) => s.toggleFolder);
  const renameNode = useRequestsStore((s) => s.renameNode);
  const deleteNode = useRequestsStore((s) => s.deleteNode);
  const createFolder = useRequestsStore((s) => s.createFolder);
  const createRequest = useRequestsStore((s) => s.createRequest);
  const duplicateRequest = useRequestsStore((s) => s.duplicateRequest);
  const clearRemote = useCollectionsStore((s) => s.clearActive);

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);

  const isActive =
    node.type === "request" &&
    node.id === activeRequestId &&
    !remoteActiveCollection;

  const commitName = () => {
    const v = draftName.trim();
    if (v && v !== node.name) renameNode(node.id, v);
    else setDraftName(node.name);
    setRenaming(false);
  };

  const handleClick = () => {
    if (renaming) return;
    if (node.type === "folder") toggleFolder(node.id);
    else {
      clearRemote();
      setActive(node.id);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 pr-1 py-1 text-sm cursor-pointer hover:bg-muted/60",
          isActive && "bg-muted",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraftName(node.name);
          setRenaming(true);
        }}
      >
        {node.type === "folder" ? (
          node.expanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {node.type === "folder" ? (
          node.expanded ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span
            className={cn(
              "text-[10px] font-bold w-10 shrink-0 text-left font-mono",
              METHOD_COLORS[node.method],
            )}
          >
            {node.method}
          </span>
        )}

        {renaming ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setDraftName(node.name);
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-background border border-input rounded px-1 text-xs h-5 outline-none focus:border-ring"
          />
        ) : (
          <span className="flex-1 truncate text-xs">{node.name}</span>
        )}

        <div className="opacity-0 group-hover:opacity-100 flex gap-0.5 shrink-0">
          {node.type === "folder" && (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Add request"
                onClick={(e) => {
                  e.stopPropagation();
                  createRequest(node.id);
                }}
              >
                <Plus className="size-3" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Add folder"
                onClick={(e) => {
                  e.stopPropagation();
                  createFolder(node.id);
                }}
              >
                <FolderPlus className="size-3" />
              </Button>
            </>
          )}
          {node.type === "request" && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="Duplicate"
              onClick={(e) => {
                e.stopPropagation();
                duplicateRequest(node.id);
              }}
            >
              <Copy className="size-3" />
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete "${node.name}"?`)) deleteNode(node.id);
            }}
          >
            <Trash2 className="size-3 text-destructive" />
          </Button>
        </div>
      </div>

      {node.type === "folder" && node.expanded && (
        <div>
          {nodes
            .filter((n) => n.parentId === node.id)
            .map((child) => (
              <LocalTreeItem key={child.id} node={child} depth={depth + 1} />
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Remote sections ────────────────────────────────────────────────────────

function OwnedSection({
  items,
  loading,
  error,
}: {
  items: CollectionMeta[];
  loading: boolean;
  error: string | null;
}) {
  const createCollection = useCollectionsStore((s) => s.createCollection);

  const handleCreate = async () => {
    const name = window.prompt("Collection name:");
    if (!name || !name.trim()) return;
    try {
      await createCollection(name.trim());
      toast.success(`Created "${name.trim()}"`);
    } catch (e) {
      toast.error("Could not create collection", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <section className="mt-2">
      <SectionHeader
        title="My Collections"
        icon={<Cloud className="size-3" />}
        count={items.length}
        actions={
          <Button
            size="icon-xs"
            variant="ghost"
            title="New remote collection"
            onClick={handleCreate}
          >
            <Plus className="size-3" />
          </Button>
        }
      />
      {error ? (
        <div className="px-3 py-2 text-xs text-destructive flex items-center gap-1.5">
          <AlertCircle className="size-3" />
          <span className="truncate">{error}</span>
        </div>
      ) : loading && items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No remote collections yet.
        </p>
      ) : (
        items.map((c) => <RemoteCollectionItem key={c.id} collection={c} />)
      )}
    </section>
  );
}

function SharedSection({
  items,
  loading,
}: {
  items: CollectionMeta[];
  loading: boolean;
}) {
  return (
    <section className="mt-2">
      <SectionHeader
        title="Shared with me"
        icon={<Users className="size-3" />}
        count={items.length}
      />
      {loading && items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Nothing shared with you yet.
        </p>
      ) : (
        items.map((c) => <RemoteCollectionItem key={c.id} collection={c} />)
      )}
    </section>
  );
}

function SaveIndicator({ collectionId }: { collectionId: string }) {
  const saving = useCollectionsStore(
    (s) => s.savingCollections[collectionId] ?? false,
  );
  const error = useCollectionsStore((s) => s.saveErrors[collectionId] ?? null);

  if (error) {
    return (
      <span title={error} className="shrink-0">
        <AlertCircle className="size-3 text-destructive" />
      </span>
    );
  }
  if (saving) {
    return (
      <span title="Saving" className="shrink-0">
        <Loader2 className="size-3 animate-spin text-muted-foreground" />
      </span>
    );
  }
  return null;
}

function RemoteCollectionItem({ collection }: { collection: CollectionMeta }) {
  const expanded = useCollectionsStore(
    (s) => s.expandedCollections[collection.id] ?? false,
  );
  const treeNodes = useCollectionsStore((s) => s.treeNodes[collection.id]);
  const treeLoading = useCollectionsStore(
    (s) => s.treeLoading[collection.id] ?? false,
  );
  const treeError = useCollectionsStore((s) => s.treeError[collection.id] ?? null);
  const toggleExpanded = useCollectionsStore((s) => s.toggleCollectionExpanded);
  const loadTree = useCollectionsStore((s) => s.loadTree);
  const renameCollection = useCollectionsStore((s) => s.renameCollection);
  const deleteCollection = useCollectionsStore((s) => s.deleteCollection);
  const addRemoteRequest = useCollectionsStore((s) => s.addRemoteRequest);
  const addRemoteFolder = useCollectionsStore((s) => s.addRemoteFolder);

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(collection.name);
  const [shareOpen, setShareOpen] = useState(false);

  const writable = collection.permission === "write";
  const isOwner = collection.isOwner;

  const rootNodes = (treeNodes ?? []).filter((n) => n.parentId === null);

  const commitRename = async () => {
    const v = draftName.trim();
    setRenaming(false);
    if (!v || v === collection.name) {
      setDraftName(collection.name);
      return;
    }
    try {
      await renameCollection(collection.id, v);
    } catch (e) {
      setDraftName(collection.name);
      toast.error("Rename failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete "${collection.name}"? This removes it for everyone it's shared with.`)) return;
    try {
      await deleteCollection(collection.id);
      toast.success("Collection deleted");
    } catch (e) {
      toast.error("Delete failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div>
      <div
        className="group flex items-center gap-1 pr-1 py-1 text-sm cursor-pointer hover:bg-muted/60"
        style={{ paddingLeft: 8 }}
        onClick={() => !renaming && toggleExpanded(collection.id)}
        onDoubleClick={(e) => {
          if (!isOwner) return;
          e.stopPropagation();
          setDraftName(collection.name);
          setRenaming(true);
        }}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        {expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-blue-500/80" />
        ) : (
          <Folder className="size-3.5 shrink-0 text-blue-500/80" />
        )}

        {renaming ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
              if (e.key === "Escape") {
                setDraftName(collection.name);
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-background border border-input rounded px-1 text-xs h-5 outline-none focus:border-ring"
          />
        ) : (
          <span className="flex-1 truncate text-xs">{collection.name}</span>
        )}

        <SaveIndicator collectionId={collection.id} />

        {!collection.isOwner && (
          <Badge
            variant={writable ? "default" : "secondary"}
            className="h-4 text-[9px] px-1 font-normal"
          >
            {collection.permission}
          </Badge>
        )}

        <div className="opacity-0 group-hover:opacity-100 flex gap-0.5 shrink-0">
          {writable && (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Add request"
                onClick={(e) => {
                  e.stopPropagation();
                  addRemoteRequest(collection.id, null);
                }}
              >
                <Plus className="size-3" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Add folder"
                onClick={(e) => {
                  e.stopPropagation();
                  addRemoteFolder(collection.id, null);
                }}
              >
                <FolderPlus className="size-3" />
              </Button>
            </>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            title="Refresh"
            onClick={(e) => {
              e.stopPropagation();
              void loadTree(collection.id, true);
            }}
          >
            <RefreshCw className={cn("size-3", treeLoading && "animate-spin")} />
          </Button>
          {isOwner && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="Share collection"
              onClick={(e) => {
                e.stopPropagation();
                setShareOpen(true);
              }}
            >
              <Share2 className="size-3" />
            </Button>
          )}
          {isOwner && (
            <Button
              size="icon-xs"
              variant="ghost"
              title="Delete collection"
              onClick={(e) => {
                e.stopPropagation();
                void handleDelete();
              }}
            >
              <Trash2 className="size-3 text-destructive" />
            </Button>
          )}
        </div>
      </div>

      {isOwner && (
        <ShareDialog
          collection={collection}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}

      {expanded && (
        <div>
          {treeError ? (
            <div className="px-3 py-1.5 ml-4 text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="size-3" />
              <span className="truncate">{treeError}</span>
            </div>
          ) : treeLoading && !treeNodes ? (
            <p className="px-3 py-1.5 ml-4 text-xs text-muted-foreground">
              Loading tree…
            </p>
          ) : rootNodes.length === 0 ? (
            <p className="px-3 py-1.5 ml-4 text-xs text-muted-foreground">
              Empty collection.
            </p>
          ) : (
            rootNodes.map((n) => (
              <RemoteTreeItem
                key={n.id}
                collectionId={collection.id}
                node={n}
                depth={1}
                writable={writable}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function RemoteTreeItem({
  collectionId,
  node,
  depth,
  writable,
}: {
  collectionId: string;
  node: RequestTreeNode;
  depth: number;
  writable: boolean;
}) {
  const treeNodes = useCollectionsStore((s) => s.treeNodes[collectionId] ?? []);
  const activeCollectionId = useCollectionsStore((s) => s.activeCollectionId);
  const activeRequestId = useCollectionsStore((s) => s.activeRequestId);
  const setActive = useCollectionsStore((s) => s.setActive);
  const toggleRemoteFolder = useCollectionsStore((s) => s.toggleRemoteFolder);
  const renameRemoteNode = useCollectionsStore((s) => s.renameRemoteNode);
  const deleteRemoteNode = useCollectionsStore((s) => s.deleteRemoteNode);
  const addRemoteRequest = useCollectionsStore((s) => s.addRemoteRequest);
  const addRemoteFolder = useCollectionsStore((s) => s.addRemoteFolder);
  const duplicateRemoteRequest = useCollectionsStore((s) => s.duplicateRemoteRequest);
  const clearLocal = useRequestsStore((s) => s.setActiveRequest);

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);

  const isActive =
    node.type === "request" &&
    activeCollectionId === collectionId &&
    activeRequestId === node.id;

  const commitName = () => {
    const v = draftName.trim();
    if (v && v !== node.name) renameRemoteNode(collectionId, node.id, v);
    else setDraftName(node.name);
    setRenaming(false);
  };

  const handleClick = () => {
    if (renaming) return;
    if (node.type === "folder") {
      toggleRemoteFolder(collectionId, node.id);
    } else {
      clearLocal(null);
      setActive(collectionId, node.id);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 pr-1 py-1 text-sm cursor-pointer hover:bg-muted/60",
          isActive && "bg-muted",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={handleClick}
        onDoubleClick={(e) => {
          if (!writable) return;
          e.stopPropagation();
          setDraftName(node.name);
          setRenaming(true);
        }}
      >
        {node.type === "folder" ? (
          node.expanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {node.type === "folder" ? (
          node.expanded ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span
            className={cn(
              "text-[10px] font-bold w-10 shrink-0 text-left font-mono",
              METHOD_COLORS[node.method],
            )}
          >
            {node.method}
          </span>
        )}

        {renaming ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setDraftName(node.name);
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-background border border-input rounded px-1 text-xs h-5 outline-none focus:border-ring"
          />
        ) : (
          <span className="flex-1 truncate text-xs">{node.name}</span>
        )}

        {writable && (
          <div className="opacity-0 group-hover:opacity-100 flex gap-0.5 shrink-0">
            {node.type === "folder" && (
              <>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="Add request"
                  onClick={(e) => {
                    e.stopPropagation();
                    addRemoteRequest(collectionId, node.id);
                  }}
                >
                  <Plus className="size-3" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title="Add folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    addRemoteFolder(collectionId, node.id);
                  }}
                >
                  <FolderPlus className="size-3" />
                </Button>
              </>
            )}
            {node.type === "request" && (
              <Button
                size="icon-xs"
                variant="ghost"
                title="Duplicate"
                onClick={(e) => {
                  e.stopPropagation();
                  duplicateRemoteRequest(collectionId, node.id);
                }}
              >
                <Copy className="size-3" />
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="ghost"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete "${node.name}"?`)) {
                  deleteRemoteNode(collectionId, node.id);
                }
              }}
            >
              <Trash2 className="size-3 text-destructive" />
            </Button>
          </div>
        )}
      </div>

      {node.type === "folder" && node.expanded && (
        <div>
          {treeNodes
            .filter((n) => n.parentId === node.id)
            .map((child) => (
              <RemoteTreeItem
                key={child.id}
                collectionId={collectionId}
                node={child}
                depth={depth + 1}
                writable={writable}
              />
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Share dialog ───────────────────────────────────────────────────────────

function ShareDialog({
  collection,
  open,
  onOpenChange,
}: {
  collection: CollectionMeta;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const listShares = useCollectionsStore((s) => s.listShares);
  const share = useCollectionsStore((s) => s.share);
  const unshare = useCollectionsStore((s) => s.unshare);

  const [shares, setShares] = useState<ShareInfo[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);

  const [username, setUsername] = useState("");
  const [permission, setPermission] = useState<CollectionPermission>("read");
  const [submitting, setSubmitting] = useState(false);

  const [suggestions, setSuggestions] = useState<UserSummary[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Load existing shares whenever the dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingShares(true);
    listShares(collection.id)
      .then((data) => {
        if (!cancelled) setShares(data);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error("Could not load shares", {
            description: e instanceof Error ? e.message : String(e),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingShares(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, collection.id, listShares]);

  // Reset form when closing
  useEffect(() => {
    if (!open) {
      setUsername("");
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, [open]);

  // Debounced username search
  useEffect(() => {
    if (!open) return;
    const q = username.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await api.get<APIResponse<UserSummary[]>>(
          `/api/v1/users/search?q=${encodeURIComponent(q)}`,
          true,
        );
        // Filter out users already shared with so the dropdown only suggests new candidates
        const existing = new Set(shares.map((s) => s.userId));
        setSuggestions((res.data ?? []).filter((u) => !existing.has(u.id)));
      } catch {
        setSuggestions([]);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [username, open, shares]);

  const handleAdd = async () => {
    const name = username.trim();
    if (!name) return;
    setSubmitting(true);
    try {
      const newShare = await share(collection.id, name, permission);
      setShares((prev) => {
        const filtered = prev.filter((s) => s.userId !== newShare.userId);
        return [...filtered, newShare].sort((a, b) =>
          a.username.localeCompare(b.username),
        );
      });
      setUsername("");
      setSuggestions([]);
      toast.success(`Shared with @${newShare.username}`);
    } catch (e) {
      toast.error("Share failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (s: ShareInfo) => {
    if (!confirm(`Revoke access for @${s.username}?`)) return;
    try {
      await unshare(collection.id, s.userId);
      setShares((prev) => prev.filter((x) => x.userId !== s.userId));
      toast.success(`Revoked @${s.username}`);
    } catch (e) {
      toast.error("Revoke failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share "{collection.name}"</DialogTitle>
          <DialogDescription>
            Give other users access to this collection. They'll see it under
            "Shared with me".
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Add user form */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Add user</Label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Input
                  placeholder="username"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setShowSuggestions(true);
                  }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() =>
                    setTimeout(() => setShowSuggestions(false), 150)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && username.trim() && !submitting) {
                      void handleAdd();
                    }
                  }}
                  className="font-mono text-sm"
                />
                {showSuggestions && suggestions.length > 0 && (
                  <div className="absolute top-full mt-1 left-0 right-0 bg-popover border rounded-md shadow-md z-20 max-h-40 overflow-auto">
                    {suggestions.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted font-mono"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setUsername(u.username);
                          setSuggestions([]);
                          setShowSuggestions(false);
                        }}
                      >
                        @{u.username}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Select
                value={permission}
                onValueChange={(v) => v && setPermission(v as CollectionPermission)}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">Read</SelectItem>
                  <SelectItem value="write">Write</SelectItem>
                </SelectContent>
              </Select>
              <Button
                disabled={!username.trim() || submitting}
                onClick={handleAdd}
              >
                {submitting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Plus className="size-3" />
                )}
                Add
              </Button>
            </div>
          </div>

          {/* Existing shares */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Shared with ({shares.length})
            </Label>
            {loadingShares ? (
              <p className="text-xs text-muted-foreground py-2">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                Not shared with anyone yet.
              </p>
            ) : (
              <ul className="space-y-1 max-h-60 overflow-auto">
                {shares.map((s) => (
                  <li
                    key={s.userId}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/40"
                  >
                    <span className="flex-1 truncate text-sm font-mono">
                      @{s.username}
                    </span>
                    <Badge
                      variant={s.permission === "write" ? "default" : "secondary"}
                      className="text-[10px] h-4 px-1.5"
                    >
                      {s.permission}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Revoke"
                      onClick={() => void handleRevoke(s)}
                    >
                      <X className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────────

function RequestEditor({
  req,
  source,
  collectionId,
  permission,
}: {
  req: RequestNode;
  source: "local" | "remote";
  collectionId: string | null;
  permission: CollectionPermission;
}) {
  const updateLocalRequest = useRequestsStore((s) => s.updateRequest);
  const renameLocalNode = useRequestsStore((s) => s.renameNode);
  const updateRemoteRequest = useCollectionsStore((s) => s.updateRemoteRequest);
  const renameRemoteNode = useCollectionsStore((s) => s.renameRemoteNode);
  const response = useRequestsStore((s) => s.responses[req.id] ?? null);
  const error = useRequestsStore((s) => s.errors[req.id] ?? null);
  const setResponse = useRequestsStore((s) => s.setResponse);
  const setError = useRequestsStore((s) => s.setError);

  const saving = useCollectionsStore((s) =>
    collectionId ? (s.savingCollections[collectionId] ?? false) : false,
  );
  const saveError = useCollectionsStore((s) =>
    collectionId ? (s.saveErrors[collectionId] ?? null) : null,
  );

  const [activeTab, setActiveTab] = useState<"headers" | "body">("headers");
  const [responseTab, setResponseTab] = useState<"body" | "headers">("body");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const [nameDraft, setNameDraft] = useState(req.name);
  useEffect(() => setNameDraft(req.name), [req.id, req.name]);

  const writable = source === "local" || permission === "write";

  const writeUpdate = (patch: Partial<Omit<RequestNode, "id" | "type" | "parentId">>) => {
    if (!writable) return;
    if (source === "local") updateLocalRequest(req.id, patch);
    else if (collectionId) updateRemoteRequest(collectionId, req.id, patch);
  };

  const writeRename = (name: string) => {
    if (!writable) return;
    if (source === "local") renameLocalNode(req.id, name);
    else if (collectionId) renameRemoteNode(collectionId, req.id, name);
  };

  const setHeaders = (updater: (prev: KeyValue[]) => KeyValue[]) => {
    writeUpdate({ headers: updater(req.headers) });
  };

  const updateHeader = (idx: number, field: keyof KeyValue, val: string | boolean) => {
    setHeaders((prev) => prev.map((h, i) => (i === idx ? { ...h, [field]: val } : h)));
  };

  const addHeader = () => {
    setHeaders((prev) => [...prev, { key: "", value: "", enabled: true }]);
  };

  const removeHeader = (idx: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSend = async () => {
    if (!req.url.trim()) return;
    const id = req.id;
    setSending(true);
    setError(id, null);
    setResponse(id, null);

    try {
      const res = await invoke<HttpResponse>("send_http_request", {
        method: req.method,
        url: req.url.trim(),
        headers: req.headers,
        body: req.body.trim() || null,
      });
      setResponse(id, res);
      setResponseTab("body");
    } catch (e) {
      setError(id, e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const copyBody = () => {
    if (!response) return;
    navigator.clipboard.writeText(response.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
      active
        ? "border-b-2 border-primary text-foreground"
        : "text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4 max-w-5xl mx-auto w-full">
      {source === "remote" && (
        <div
          className={cn(
            "flex items-center gap-2 text-xs border rounded-md px-3 py-2",
            writable
              ? "bg-muted/40 text-muted-foreground"
              : "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
          )}
        >
          <Cloud className="size-3.5 shrink-0" />
          <span className="flex-1 truncate">
            {writable ? "Remote — autosaving" : "Remote — read-only"}
          </span>
          {writable && (
            <span className="font-mono text-[10px]">
              {saveError ? (
                <span className="text-destructive">save failed</span>
              ) : saving ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" /> saving…
                </span>
              ) : (
                <span className="text-green-600 dark:text-green-400">saved</span>
              )}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Send className="h-5 w-5 text-muted-foreground shrink-0" />
        <input
          value={nameDraft}
          onChange={(e) => writable && setNameDraft(e.target.value)}
          readOnly={!writable}
          onBlur={() => {
            if (!writable) return;
            const v = nameDraft.trim();
            if (v && v !== req.name) writeRename(v);
            else setNameDraft(req.name);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className={cn(
            "flex-1 text-xl font-semibold bg-transparent outline-none border-0 rounded px-1 -ml-1",
            writable ? "focus:bg-muted/30" : "cursor-default",
          )}
        />
      </div>

      {/* URL bar */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-2">
            <Select
              value={req.method}
              disabled={!writable}
              onValueChange={(v) => v && writeUpdate({ method: v })}
            >
              <SelectTrigger className="w-32">
                <SelectValue>
                  <span className={METHOD_COLORS[req.method]}>{req.method}</span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    <span className={METHOD_COLORS[m]}>{m}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              placeholder="https://api.example.com/endpoint"
              value={req.url}
              readOnly={!writable}
              onChange={(e) => writeUpdate({ url: e.target.value })}
              className="flex-1 font-mono text-sm"
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
            />
            <Button onClick={handleSend} disabled={sending || !req.url.trim()}>
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              <span className="ml-1.5">Send</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Request config */}
      <Card>
        <div className="flex border-b px-4">
          <button
            className={tabClass(activeTab === "headers")}
            onClick={() => setActiveTab("headers")}
          >
            Headers ({req.headers.filter((h) => h.enabled && h.key).length})
          </button>
          <button
            className={tabClass(activeTab === "body")}
            onClick={() => setActiveTab("body")}
          >
            Body
          </button>
        </div>

        <CardContent className="pt-4">
          {activeTab === "headers" && (
            <div className="space-y-2">
              {req.headers.map((h, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <input
                    type="checkbox"
                    checked={h.enabled}
                    disabled={!writable}
                    onChange={(e) => updateHeader(idx, "enabled", e.target.checked)}
                    className="shrink-0"
                  />
                  <Input
                    placeholder="Key"
                    value={h.key}
                    readOnly={!writable}
                    onChange={(e) => updateHeader(idx, "key", e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                  />
                  <Input
                    placeholder="Value"
                    value={h.value}
                    readOnly={!writable}
                    onChange={(e) => updateHeader(idx, "value", e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                  />
                  {writable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeHeader(idx)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              ))}
              {writable && (
                <Button variant="outline" size="sm" onClick={addHeader}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add Header
                </Button>
              )}
            </div>
          )}

          {activeTab === "body" && (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                Raw body (JSON, XML, text, etc.)
              </Label>
              <Textarea
                placeholder='{"key": "value"}'
                value={req.body}
                readOnly={!writable}
                onChange={(e) => writeUpdate({ body: e.target.value })}
                className="font-mono text-xs min-h-[160px] resize-y"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-destructive font-mono">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Response */}
      {response && (
        <Card>
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="flex items-center gap-3">
              <Badge variant={statusVariant(response.status)} className="font-mono">
                {response.status} {response.status_text}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {response.elapsed_ms}ms
              </span>
              <span className="text-xs text-muted-foreground">
                {formatSize(response.size_bytes)}
              </span>
            </div>
            <div className="flex gap-1">
              <button
                className={tabClass(responseTab === "body")}
                onClick={() => setResponseTab("body")}
              >
                Body
              </button>
              <button
                className={tabClass(responseTab === "headers")}
                onClick={() => setResponseTab("headers")}
              >
                Headers ({response.headers.length})
              </button>
            </div>
          </div>

          <CardContent className="pt-4">
            {responseTab === "body" && (
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-0 right-0 z-10"
                  onClick={copyBody}
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
                <pre className="font-mono text-xs bg-muted/50 rounded-md p-4 overflow-auto max-h-[500px] whitespace-pre-wrap break-all">
                  {tryFormatJson(response.body) || "(empty)"}
                </pre>
              </div>
            )}

            {responseTab === "headers" && (
              <div className="space-y-1">
                {response.headers.map((h, idx) => (
                  <div key={idx} className="flex gap-2 font-mono text-xs">
                    <span className="text-muted-foreground min-w-[180px] shrink-0">
                      {h.key}:
                    </span>
                    <span className="break-all">{h.value}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
