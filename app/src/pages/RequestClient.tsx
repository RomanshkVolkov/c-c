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
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
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
import { cn } from "@/lib/utils";
import {
  useRequestsStore,
  type HttpResponse,
  type KeyValue,
  type RequestNode,
  type RequestTreeNode,
} from "@/store/requests.store";

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

export default function RequestClient() {
  const nodes = useRequestsStore((s) => s.nodes);
  const activeRequestId = useRequestsStore((s) => s.activeRequestId);
  const createRequest = useRequestsStore((s) => s.createRequest);

  const found = nodes.find((n) => n.id === activeRequestId);
  const activeRequest = found && found.type === "request" ? found : null;

  useEffect(() => {
    if (nodes.length === 0) createRequest(null);
  }, [nodes.length, createRequest]);

  return (
    <div className="flex-1 flex min-h-0">
      <CollectionsSidebar />
      <div className="flex-1 flex flex-col min-h-0">
        {activeRequest ? (
          <RequestEditor key={activeRequest.id} req={activeRequest} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                Select a request from the sidebar or create a new one.
              </p>
              <Button size="sm" onClick={() => createRequest(null)}>
                <Plus className="size-3 mr-1" /> New Request
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CollectionsSidebar() {
  const nodes = useRequestsStore((s) => s.nodes);
  const createFolder = useRequestsStore((s) => s.createFolder);
  const createRequest = useRequestsStore((s) => s.createRequest);

  const rootNodes = nodes.filter((n) => n.parentId === null);

  return (
    <aside className="w-72 shrink-0 border-r flex flex-col bg-muted/10">
      <header className="h-12 flex items-center justify-between px-3 border-b shrink-0">
        <span className="text-sm font-medium">Collections</span>
        <div className="flex gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => createFolder(null)}
            title="New folder"
          >
            <FolderPlus className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => createRequest(null)}
            title="New request"
          >
            <Plus className="size-3" />
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-auto py-1">
        {rootNodes.length === 0 ? (
          <p className="px-3 py-6 text-xs text-muted-foreground text-center">
            No requests yet.
          </p>
        ) : (
          rootNodes.map((n) => <TreeItem key={n.id} node={n} depth={0} />)
        )}
      </div>
    </aside>
  );
}

function TreeItem({ node, depth }: { node: RequestTreeNode; depth: number }) {
  const nodes = useRequestsStore((s) => s.nodes);
  const activeRequestId = useRequestsStore((s) => s.activeRequestId);
  const setActive = useRequestsStore((s) => s.setActiveRequest);
  const toggleFolder = useRequestsStore((s) => s.toggleFolder);
  const renameNode = useRequestsStore((s) => s.renameNode);
  const deleteNode = useRequestsStore((s) => s.deleteNode);
  const createFolder = useRequestsStore((s) => s.createFolder);
  const createRequest = useRequestsStore((s) => s.createRequest);
  const duplicateRequest = useRequestsStore((s) => s.duplicateRequest);

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);

  const isActive = node.type === "request" && node.id === activeRequestId;

  const commitName = () => {
    const v = draftName.trim();
    if (v && v !== node.name) renameNode(node.id, v);
    else setDraftName(node.name);
    setRenaming(false);
  };

  const handleClick = () => {
    if (renaming) return;
    if (node.type === "folder") toggleFolder(node.id);
    else setActive(node.id);
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
              <TreeItem key={child.id} node={child} depth={depth + 1} />
            ))}
        </div>
      )}
    </div>
  );
}

function RequestEditor({ req }: { req: RequestNode }) {
  const updateRequest = useRequestsStore((s) => s.updateRequest);
  const renameNode = useRequestsStore((s) => s.renameNode);
  const response = useRequestsStore((s) => s.responses[req.id] ?? null);
  const error = useRequestsStore((s) => s.errors[req.id] ?? null);
  const setResponse = useRequestsStore((s) => s.setResponse);
  const setError = useRequestsStore((s) => s.setError);

  const [activeTab, setActiveTab] = useState<"headers" | "body">("headers");
  const [responseTab, setResponseTab] = useState<"body" | "headers">("body");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const [nameDraft, setNameDraft] = useState(req.name);
  useEffect(() => setNameDraft(req.name), [req.id, req.name]);

  const setHeaders = (updater: (prev: KeyValue[]) => KeyValue[]) => {
    updateRequest(req.id, { headers: updater(req.headers) });
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
      <div className="flex items-center gap-3">
        <Send className="h-5 w-5 text-muted-foreground shrink-0" />
        <input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            const v = nameDraft.trim();
            if (v && v !== req.name) renameNode(req.id, v);
            else setNameDraft(req.name);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="flex-1 text-xl font-semibold bg-transparent outline-none border-0 focus:bg-muted/30 rounded px-1 -ml-1"
        />
      </div>

      {/* URL bar */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-2">
            <Select
              value={req.method}
              onValueChange={(v) => v && updateRequest(req.id, { method: v })}
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
              onChange={(e) => updateRequest(req.id, { url: e.target.value })}
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
                    onChange={(e) => updateHeader(idx, "enabled", e.target.checked)}
                    className="shrink-0"
                  />
                  <Input
                    placeholder="Key"
                    value={h.key}
                    onChange={(e) => updateHeader(idx, "key", e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                  />
                  <Input
                    placeholder="Value"
                    value={h.value}
                    onChange={(e) => updateHeader(idx, "value", e.target.value)}
                    className="flex-1 font-mono text-xs h-8"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeHeader(idx)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addHeader}>
                <Plus className="h-3 w-3 mr-1" />
                Add Header
              </Button>
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
                onChange={(e) => updateRequest(req.id, { body: e.target.value })}
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
