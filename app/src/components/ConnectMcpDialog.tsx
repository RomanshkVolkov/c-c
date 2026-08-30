import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Plus, Trash2, Pencil, Loader2, TriangleAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScopeChecklist, describeScopes } from "@/components/mcp-scopes";
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
      <pre className="overflow-auto rounded bg-muted/50 px-2 py-1.5 text-xs whitespace-pre-wrap break-all">
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
  const { t } = useT();
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("Claude Code");
  // All off by default: a token that can write is a token someone can lose.
  const [scopes, setScopes] = useState<string[]>([]);
  const toggleScope = (id: string, on: boolean) =>
    setScopes((prev) => (on ? [...prev, id] : prev.filter((s) => s !== id)));
  // Which token is being re-permissioned, and the set being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [editScopes, setEditScopes] = useState<string[]>([]);
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
          scopes,
        },
        true,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? t("common:last.failed"));
      setMinted(res.data);
      load();
    } catch (e) {
      toast.error(t("common:admin.errCreateToken"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const saveScopes = async (tok: AccessToken) => {
    try {
      // The secret is untouched — this is what the token may do, not who it is,
      // so nothing anywhere has to be re-pasted.
      const res = await api.patch<APIResponse<AccessToken>>(
        `/api/v1/auth/tokens/${tok.id}`,
        { scopes: editScopes },
      );
      if (!res.success) throw new Error(res.error ?? t("common:last.failed"));
      setEditing(null);
      load();
      toast.success(t("common:last.permsUpdated", { name: tok.name }));
    } catch (e) {
      toast.error(t("common:admin.errUpdateScopes"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const revoke = async (tok: AccessToken) => {
    const ok = await confirm({
      title: `Revoke "${tok.name}"?`,
      description: t("common:admin.revokeBody"),
      confirmText: t("common:admin.revoke"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete<APIResponse<unknown>>(`/api/v1/auth/tokens/${tok.id}`);
      setTokens((prev) => prev.filter((x) => x.id !== tok.id));
    } catch (e) {
      toast.error(t("common:admin.errRevoke"), {
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
          <DialogTitle>{t("common:admin.connectClaude")}</DialogTitle>
          <DialogDescription>
            {t("common:admin.connectLead")}
            live. Read access is always granted; it can create or change tasks and notes
            only if you check the matching permission below.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-auto">
          {minted ? (
            <div className="space-y-3 rounded-lg border p-3">
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {t("common:admin.copyTokenNow")}
              </p>
              <CopyField label={t("common:admin.token")} value={minted.value} />
              <CopyField label="Command (Claude Code)" value={cmd} />
              <CopyField label="Or paste into claude_desktop_config.json" value={jsonSnippet} />
              <Button variant="outline" size="sm" onClick={() => setMinted(null)}>
                {t("common:admin.done")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <Label>{t("common:admin.tokenName")}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Claude Code"
                />
              </div>
              {/* Split by what each can destroy: adding a task, a comment or a
                  page can't overwrite anyone's work — changing one can. Reading
                  needs no permission at all, which is why another app can drive
                  its own "my reports" view with a token that grants nothing. */}
              <ScopeChecklist selected={scopes} onToggle={toggleScope} />
              <p className="text-xs text-muted-foreground">
                {t("common:admin.readOnlyNote")}
                listing and opening reports, tasks and notes. Deleting anything, and
                minting tokens, stay refused in every case.
              </p>
              <Button onClick={mint} className="self-start">
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
              <p className="text-xs text-muted-foreground">{t("common:admin.noTokens")}</p>
            ) : (
              <div className="divide-y rounded-lg border">
                {tokens.map((tok) => (
                  <div key={tok.id} className="px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{tok.name}</span>
                      <code className="text-xs text-muted-foreground">{tok.preview}</code>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {tok.lastUsedAt
                          ? `used ${new Date(tok.lastUsedAt).toLocaleDateString()}`
                          : "never used"}
                        {tok.expiresAt && ` · expires ${new Date(tok.expiresAt).toLocaleDateString()}`}
                      </span>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title={t("common:admin.changePermissions")}
                        onClick={() => {
                          setEditing(editing === tok.id ? null : tok.id);
                          setEditScopes(tok.scopes ?? []);
                        }}
                      >
                        <Pencil className="size-3" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="text-destructive/70 hover:text-destructive"
                        onClick={() => revoke(tok)}
                        title={t("common:admin.revoke")}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                    {editing === tok.id ? (
                      <div className="mt-2 space-y-2 rounded border bg-muted/30 p-2">
                        <ScopeChecklist
                          selected={editScopes}
                          onToggle={(id, on) =>
                            setEditScopes((prev) =>
                              on ? [...prev, id] : prev.filter((s) => s !== id),
                            )
                          }
                          compact
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("common:admin.tokenUnchanged")}
                          updated.
                        </p>
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => saveScopes(tok)}>{t("common:admin.save")}</Button>
                          <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                            {t("common:admin.cancel")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {describeScopes(tok.scopes)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1 rounded-lg border p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t("common:admin.whatAssistantCanDo")}</p>
            <p>
              Always: list projects and reports, open a report with its telemetry, list
              devices and pull a device's diagnostics timeline, browse tasks and read
              notes.
            </p>
            <p className="pt-1">
              With the permissions above: reply to reports, create tasks/comments or
              notes pages, and — only with "change existing" or "triage" checked —
              move tasks between columns, overwrite a task's fields or a note's
              title/body, triage a report, and correct or withdraw your own replies.
            </p>
            <p className="pt-1">
              <Badge variant="secondary" className="text-xs">{t("common:admin.note")}</Badge> whatever it reads
              (reports, device telemetry, task and note content) is sent to your AI client.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
