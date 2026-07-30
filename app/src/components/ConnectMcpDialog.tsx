import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Plus, Trash2, Loader2, TriangleAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { AccessToken, CreateTokenResult } from "@/types/token";

const BASE_URL = import.meta.env.VITE_API_URL ?? "https://cac.guz-studio.dev";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Label className="text-xs">{label}</Label>
        <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={copy}>
          {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        </Button>
      </div>
      <pre className="overflow-auto rounded bg-muted/50 px-2 py-1.5 text-[11px] whitespace-pre-wrap break-all">
        {value}
      </pre>
    </div>
  );
}

/**
 * "Connect Claude Code": mints a read-only token and shows the exact command to
 * register this app as an MCP server. cac never writes to your MCP client's
 * config — everything here is copy-paste, on purpose.
 */
export default function ConnectMcpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("Claude Code");
  // Both off by default: a token that can write is a token someone can lose.
  const [canCreateTasks, setCanCreateTasks] = useState(false);
  const [canManageTasks, setCanManageTasks] = useState(false);
  const [minted, setMinted] = useState<CreateTokenResult | null>(null);
  const [exePath, setExePath] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<APIResponse<AccessToken[]>>("/api/v1/auth/tokens");
      setTokens(res.success && res.data ? res.data : []);
    } catch {
      /* the dialog still works for minting */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
    invoke<string>("executable_path")
      .then(setExePath)
      .catch(() => setExePath("cac"));
  }, [open, load]);

  const mint = async () => {
    try {
      const res = await api.post<APIResponse<CreateTokenResult>>(
        "/api/v1/auth/tokens",
        {
          name: name.trim() || "Claude Code",
          scopes: [
            ...(canCreateTasks ? ["tasks:write"] : []),
            ...(canManageTasks ? ["tasks:manage"] : []),
          ],
        },
        true,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? "Failed");
      setMinted(res.data);
      load();
    } catch (e) {
      toast.error("Could not create token", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const revoke = async (t: AccessToken) => {
    const ok = await confirm({
      title: `Revoke "${t.name}"?`,
      description: "Any MCP client or script using this token stops working immediately.",
      confirmText: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete<APIResponse<unknown>>(`/api/v1/auth/tokens/${t.id}`);
      setTokens((prev) => prev.filter((x) => x.id !== t.id));
    } catch (e) {
      toast.error("Could not revoke", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const cmd = minted
    ? `claude mcp add cac -e CAC_URL=${BASE_URL} -e CAC_TOKEN=${minted.value} -- "${exePath}" --mcp`
    : "";
  const jsonSnippet = minted
    ? JSON.stringify(
        {
          mcpServers: {
            cac: {
              command: exePath,
              args: ["--mcp"],
              env: { CAC_URL: BASE_URL, CAC_TOKEN: minted.value },
            },
          },
        },
        null,
        2,
      )
    : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setMinted(null); // the plaintext token never survives the dialog
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect Claude Code</DialogTitle>
          <DialogDescription>
            Lets an AI assistant read your reports and device diagnostics live. Access is
            strictly read-only — the token cannot change anything in cac.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-auto">
          {minted ? (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                Copy the token now — it is shown once and cac doesn't store it.
              </p>
              <CopyField label="Token" value={minted.value} />
              <CopyField label="Command (Claude Code)" value={cmd} />
              <CopyField label="Or paste into claude_desktop_config.json" value={jsonSnippet} />
              <Button variant="outline" size="sm" onClick={() => setMinted(null)}>
                Done
              </Button>
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>Token name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Claude Code"
                />
              </div>
              {/* Two permissions, split by what they can destroy: adding a task or
                  a comment can't overwrite anyone's work — changing one can. */}
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={canCreateTasks}
                  onChange={(e) => setCanCreateTasks(e.target.checked)}
                />
                <span>
                  <span className="text-foreground">Create tasks and comments</span>
                  <span className="block">
                    Append-only: it can add, never replace what someone wrote.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={canManageTasks}
                  onChange={(e) => setCanManageTasks(e.target.checked)}
                />
                <span>
                  <span className="text-foreground">Change existing tasks</span>
                  <span className="block">
                    Move them between columns, and overwrite title, description or
                    priority. Needed to mark work as done.
                  </span>
                </span>
              </label>
              <p className="text-[11px] text-muted-foreground">
                Without either, the token can only read. Deleting anything, and
                minting tokens, stay refused in every case.
              </p>
              <Button onClick={mint}>
                <Plus className="size-4 mr-1" /> Create token
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              Active tokens ({tokens.length})
            </Label>
            {loading && tokens.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <Loader2 className="inline size-3 animate-spin" /> Loading…
              </p>
            ) : tokens.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tokens yet.</p>
            ) : (
              <div className="divide-y rounded-lg border">
                {tokens.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="truncate font-medium">{t.name}</span>
                    <code className="text-[11px] text-muted-foreground">{t.preview}</code>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {t.lastUsedAt
                        ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                        : "never used"}
                      {t.expiresAt && ` · expires ${new Date(t.expiresAt).toLocaleDateString()}`}
                    </span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="text-destructive/70 hover:text-destructive"
                      onClick={() => revoke(t)}
                      title="Revoke"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1 rounded-lg border p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">What the assistant can do</p>
            <p>
              Read-only: list projects and reports, open a report with its telemetry, list
              devices and pull a device's diagnostics timeline. It cannot comment, change
              status, or modify anything.
            </p>
            <p className="pt-1">
              <Badge variant="secondary" className="text-[10px]">Note</Badge> whatever it reads
              (reports, device telemetry) is sent to your AI client.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
