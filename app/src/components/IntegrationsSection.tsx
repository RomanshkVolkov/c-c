import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  ExternalLink,
  KeyRound,
  Copy,
  Check,
  Pencil,
  Trash2,
  LayoutGrid,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, apiUrl } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  Integration,
  CreateIntegrationPayload,
  UpdateIntegrationPayload,
} from "@/types/k8s";

// Vault + launcher for a k8s server's tools (Grafana, pgAdmin, generic…).
export default function IntegrationsSection({
  serverId,
  canAdmin,
  canReveal,
}: {
  serverId: string;
  canAdmin: boolean;
  canReveal: boolean;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const [items, setItems] = useState<Integration[]>([]);
  const [dialog, setDialog] = useState<{ open: boolean; editing: Integration | null }>({
    open: false,
    editing: null,
  });

  const base = `/api/v1/servers/${serverId}/integrations`;

  const load = useCallback(async () => {
    try {
      const res = await api.get<APIResponse<Integration[]>>(base);
      setItems(res.success && res.data ? res.data : []);
    } catch {
      /* surfaced by the hub's own error handling */
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (it: Integration) => {
    const ok = await confirm({
      title: `Delete integration "${it.name}"?`,
      description: t("common:admin.deleteTileBody"),
      confirmText: t("common:admin.delete"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.delete<APIResponse<unknown>>(`${base}/${it.id}`);
      setItems((prev) => prev.filter((x) => x.id !== it.id));
    } catch (e) {
      toast.error(t("common:admin.errDelete"), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <LayoutGrid className="size-4" /> Integrations
        </h2>
        {canAdmin && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => setDialog({ open: true, editing: null })}
          >
            <Plus className="size-4 mr-1" /> Add
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("common:admin.noIntegrations")}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {items.map((it) => (
            <IntegrationTile
              key={it.id}
              it={it}
              base={base}
              canAdmin={canAdmin}
              canReveal={canReveal}
              onEdit={() => setDialog({ open: true, editing: it })}
              onDelete={() => remove(it)}
            />
          ))}
        </div>
      )}

      {dialog.open && (
        <IntegrationDialog
          base={base}
          editing={dialog.editing}
          onClose={(changed) => {
            setDialog({ open: false, editing: null });
            if (changed) load();
          }}
        />
      )}
    </section>
  );
}

function IntegrationTile({
  it,
  base,
  canAdmin,
  canReveal,
  onEdit,
  onDelete,
}: {
  it: Integration;
  base: string;
  canAdmin: boolean;
  canReveal: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Tools configured with `header` auth are reached through cac's authenticated
  // proxy: cac asserts your identity (Grafana auth.proxy), so you land signed in
  // — and the tool itself needs no public exposure. Everything else opens direct.
  const open = async () => {
    let href = it.url;
    if (it.authMethod === "header") {
      try {
        const res = await api.post<APIResponse<{ path: string }>>(`${base}/${it.id}/launch`, {}, true);
        if (res.data?.path) href = apiUrl(res.data.path);
      } catch (e) {
        toast.error(t("common:admin.errOpenThrough"), {
          description: e instanceof Error ? e.message : String(e),
        });
        return;
      }
    }
    try {
      await openUrl(href);
    } catch {
      window.open(href, "_blank");
    }
  };

  const reveal = async () => {
    try {
      const res = await api.post<APIResponse<{ secret: string }>>(`${base}/${it.id}/reveal`, {}, true);
      setRevealed(res.data?.secret ?? "");
    } catch (e) {
      toast.error(t("common:admin.errReveal"), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const copy = () => {
    if (revealed == null) return;
    navigator.clipboard.writeText(revealed);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex items-center gap-2">
        <button onClick={open} className="group flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="truncate font-medium">{it.name}</span>
          <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
        <Badge variant="secondary" className="text-xs">{it.kind}</Badge>
        {it.authMethod === "header" && (
          <Badge className="text-xs" title={t("common:admin.ssoTitle")}>SSO</Badge>
        )}
        {canAdmin && (
          <>
            <button className="text-muted-foreground hover:text-foreground" onClick={onEdit} title={t("common:admin.edit")}>
              <Pencil className="size-3.5" />
            </button>
            <button className="text-destructive/70 hover:text-destructive" onClick={onDelete} title={t("common:admin.delete")}>
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>
      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{it.url}</p>

      {it.hasSecret && canReveal && (
        <div className="mt-2">
          {revealed == null ? (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={reveal}>
              <KeyRound className="size-3 mr-1" /> Reveal credentials
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <pre className="min-h-0 flex-1 overflow-auto rounded bg-muted/50 px-2 py-1 text-xs whitespace-pre-wrap break-all">
                {revealed || "(empty)"}
              </pre>
              <Button size="icon-xs" variant="ghost" onClick={copy} title={t("common:admin.copy")}>
                {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const KINDS = ["grafana", "pgadmin", "argocd", "traefik", "prometheus", "generic"];

function IntegrationDialog({
  base,
  editing,
  onClose,
}: {
  base: string;
  editing: Integration | null;
  onClose: (changed: boolean) => void;
}) {
  const { t } = useT();
  const [kind, setKind] = useState(editing?.kind ?? "generic");
  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(editing?.url ?? "");
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Grafana is the one tool cac can sign you into (auth.proxy), so default it on.
  const [sso, setSso] = useState(
    editing ? editing.authMethod === "header" : false,
  );

  const pickKind = (k: string) => {
    setKind(k);
    if (!editing) setSso(k === "grafana");
  };

  const submit = async () => {
    if (!name.trim() || !url.trim()) return;
    setSubmitting(true);
    try {
      const authMethod = sso ? "header" : "none";
      if (editing) {
        const body: UpdateIntegrationPayload = {
          name: name.trim(),
          url: url.trim(),
          authMethod,
        };
        if (secret) body.secret = secret; // only replace when typed
        await api.patch<APIResponse<unknown>>(`${base}/${editing.id}`, body, true);
      } else {
        const body: CreateIntegrationPayload = {
          kind,
          name: name.trim(),
          url: url.trim(),
          authMethod,
          ...(secret ? { secret } : {}),
        };
        await api.post<APIResponse<unknown>>(base, body, true);
      }
      onClose(true);
    } catch (e) {
      toast.error(t("common:admin.errSave"), { description: e instanceof Error ? e.message : String(e) });
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? t("common:admin.editIntegration", { name: editing.name }) : t("common:admin.addIntegration")}
          </DialogTitle>
          <DialogDescription>
            {t("common:admin.integrationLead")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {!editing && (
            <div className="space-y-1.5">
              <Label>{t("common:admin.kind")}</Label>
              <select
                value={kind}
                onChange={(e) => pickKind(e.target.value)}
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t("common:admin.thName")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Grafana" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>{t("common:admin.url")}</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://grafana.example" />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={sso}
              onChange={(e) => setSso(e.target.checked)}
              className="mt-0.5 size-4"
            />
            <span>
              Open through cac (SSO)
              <span className="block text-xs text-muted-foreground">
                cac proxies the tool and signs you in as your cac user. Requires the
                tool to trust proxy auth (Grafana <code>auth.proxy</code>). Use an
                in-cluster URL — it needs no public exposure.
              </span>
            </span>
          </label>
          <div className="space-y-1.5">
            <Label>Credentials (optional)</Label>
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={editing?.hasSecret ? "•••• (unchanged)" : "user/pass or token"}
            />
            <p className="text-xs text-muted-foreground">
              {t("common:admin.storedEncrypted")} {editing?.hasSecret && t("common:admin.leaveBlankKeep")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)}>{t("common:admin.cancel")}</Button>
          <Button onClick={submit} disabled={submitting || !name.trim() || !url.trim()}>
            {submitting ? t("common:admin.saving") : t("common:admin.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
