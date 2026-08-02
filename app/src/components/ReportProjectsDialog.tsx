import { useState } from "react";
import { Plus, KeyRound, Copy, Trash2, Check, Pencil, RefreshCw, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import OriginsEditor, { cleanOrigins } from "@/components/OriginsEditor";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useConfirm } from "@/components/ConfirmDialog";
import { roleAtLeast } from "@/types/organization";
import type { ReportProject } from "@/types/report";

/**
 * How a project is authenticated, not how it looks. "web" is a browser widget
 * whose Origin is checked against an allowlist; "app" is a server calling the
 * ingest directly, which sends no Origin at all — picking the wrong one is how
 * a server-to-server integration gets refused the moment a proxy adds a header.
 */
/** 32 bytes from the platform CSPRNG, URL-safe so it survives any env file. */
function randomSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PLATFORM_LABELS: Record<"web" | "app", string> = {
  web: "Browser widget",
  app: "Server-to-server",
};

/**
 * Outbound webhook. Optional, and the secret is write-only: the server never
 * returns it, so an edit that leaves the field blank means "keep the current
 * one" rather than "stop signing".
 */
function WebhookFields({
  url,
  secret,
  onUrl,
  onSecret,
  configured,
}: {
  url: string;
  secret: string;
  onUrl: (v: string) => void;
  onSecret: (v: string) => void;
  configured?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>Webhook (optional)</Label>
      <Input
        value={url}
        onChange={(e) => onUrl(e.target.value)}
        placeholder="https://your-app/api/webhooks/cac-reports"
      />
      <div className="flex items-center gap-2">
        <Input
          value={secret}
          onChange={(e) => onSecret(e.target.value)}
          placeholder={
            configured ? "Signing secret set — type to replace it" : "Signing secret (min 16 chars)"
          }
        />
        {/* A signing secret has no reason to be memorable, and one a person
            invents is the weakest link in an otherwise fine HMAC. */}
        <Button size="sm" variant="outline" onClick={() => onSecret(randomSecret())}>
          <RefreshCw className="h-3.5 w-3.5" /> Generate
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Every report event is POSTed here, signed with{" "}
        <code className="text-[10px]">X-Cac-Signature</code>. Verify it over the raw body.
      </p>
    </div>
  );
}

export default function ReportProjectsDialog({ trigger }: { trigger: React.ReactNode }) {
  const projects = useReportsStore((s) => s.projects);
  const createProject = useReportsStore((s) => s.createProject);
  const rotateProjectKey = useReportsStore((s) => s.rotateProjectKey);
  const deleteProject = useReportsStore((s) => s.deleteProject);
  const role = useOrgsStore((s) => s.currentOrg()?.role);
  const confirm = useConfirm();

  const canWrite = !!role && roleAtLeast(role, "member");
  const canDelete = role === "admin";

  const [name, setName] = useState("");
  const [origins, setOrigins] = useState<string[]>([""]);
  const [rate, setRate] = useState("20");
  const [platform, setPlatform] = useState<"web" | "app">("web");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ title: string; secrets: Once[] } | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const key = await createProject({
        name: name.trim(),
        allowedOrigins: cleanOrigins(origins),
        rateLimitPerHour: Number(rate) || 20,
        platform,
        webhookUrl: webhookUrl.trim(),
        webhookSecret: webhookSecret.trim(),
      });
      // The webhook secret is equally unrecoverable, so it belongs in the same
      // panel — revealing one and swallowing the other is how it gets lost.
      setRevealed({
        title: name.trim(),
        secrets: [
          { name: "ingest_key", label: "Ingest key", value: key },
          ...(webhookSecret.trim()
            ? [{ name: "webhook_secret", label: "Webhook signing secret", value: webhookSecret.trim() }]
            : []),
        ],
      });
      setName("");
      setOrigins([""]);
      setRate("20");
      setPlatform("web");
      setWebhookUrl("");
      setWebhookSecret("");
    } catch (e) {
      toast.error("Failed to create project", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCreating(false);
    }
  };

  const handleRotate = async (id: string, pname: string) => {
    const ok = await confirm({
      title: `Rotate ingest key for "${pname}"?`,
      description: "The current key stops working immediately — any client still using it will fail to ingest until updated.",
      confirmText: "Rotate key",
      destructive: true,
    });
    if (!ok) return;
    try {
      const key = await rotateProjectKey(id);
      setRevealed({
        title: pname,
        secrets: [{ name: "ingest_key", label: "New ingest key", value: key }],
      });
    } catch (e) {
      toast.error("Failed to rotate key", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleDelete = async (id: string, pname: string) => {
    const ok = await confirm({
      title: `Delete project "${pname}"?`,
      description: "Its ingest key stops working and the project is removed. Existing reports stay.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteProject(id);
    } catch (e) {
      toast.error("Failed to delete project", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Dialog>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Report projects</DialogTitle>
          <DialogDescription>
            Each project is a client website that ingests reports. The ingest key
            is public (rides in the widget) but write-only.
          </DialogDescription>
        </DialogHeader>

        {revealed && (
          <RevealedSecrets
            title={revealed.title}
            secrets={revealed.secrets}
            onDone={() => setRevealed(null)}
          />
        )}

        {canWrite && !revealed && (
          <div className="rounded-md border p-3 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Plus className="h-4 w-4" /> New project
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cliente Web" />
              </div>
              <div className="space-y-1">
                <Label>Rate limit / hour</Label>
                <Input type="number" value={rate} onChange={(e) => setRate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Integration</Label>
              <Select
                items={PLATFORM_LABELS}
                value={platform}
                onValueChange={(v) => v && setPlatform(v as "web" | "app")}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PLATFORM_LABELS) as ("web" | "app")[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {PLATFORM_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {platform === "web"
                  ? "Reports come from a browser, so the Origin allowlist below is enforced."
                  : "Reports come from a server, which sends no Origin — the allowlist doesn't apply."}
              </p>
            </div>
            {/* Only a browser project has an Origin to police. */}
            {platform === "web" && <OriginsEditor value={origins} onChange={setOrigins} />}
            <WebhookFields
              url={webhookUrl}
              secret={webhookSecret}
              onUrl={setWebhookUrl}
              onSecret={setWebhookSecret}
            />
            <Button size="sm" onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create project"}
            </Button>
          </div>
        )}

        <div className="space-y-2 max-h-80 overflow-y-auto">
          {projects.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">No projects yet.</p>
          )}
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              canWrite={canWrite}
              canDelete={canDelete}
              onRotate={() => handleRotate(p.id, p.name)}
              onDelete={() => handleDelete(p.id, p.name)}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRow({
  project: p,
  canWrite,
  canDelete,
  onRotate,
  onDelete,
}: {
  project: ReportProject;
  canWrite: boolean;
  canDelete: boolean;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const updateProject = useReportsStore((s) => s.updateProject);
  const setProjectActive = useReportsStore((s) => s.setProjectActive);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [rate, setRate] = useState(String(p.rateLimitPerHour));
  const [origins, setOrigins] = useState<string[]>(p.allowedOrigins.length ? p.allowedOrigins : [""]);
  const [webhookUrl, setWebhookUrl] = useState(p.webhookUrl ?? "");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setName(p.name);
    setRate(String(p.rateLimitPerHour));
    setOrigins(p.allowedOrigins.length ? p.allowedOrigins : [""]);
    setWebhookUrl(p.webhookUrl ?? "");
    // Never prefilled: the server doesn't return it, and showing a placeholder
    // secret would make "leave it alone" look like "here it is".
    setWebhookSecret("");
    setEditing(true);
  };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await updateProject(p.id, {
        name: name.trim(),
        allowedOrigins: cleanOrigins(origins),
        rateLimitPerHour: Number(rate) || 20,
        isActive: p.isActive,
        webhookUrl: webhookUrl.trim(),
        webhookSecret: webhookSecret.trim(),
      });
      setEditing(false);
    } catch (e) {
      toast.error("Failed to save", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="rounded-md border p-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Rate limit / hour</Label>
            <Input type="number" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
        </div>
        {/* Only a browser project has an Origin to police — platform itself is
            fixed at creation, since it decides how the project authenticates. */}
        {p.platform !== "app" && <OriginsEditor value={origins} onChange={setOrigins} />}
        <WebhookFields
          url={webhookUrl}
          secret={webhookSecret}
          onUrl={setWebhookUrl}
          onSecret={setWebhookSecret}
          configured={p.webhookConfigured}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border p-2.5 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{p.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{p.slug}</span>
          {!p.isActive && <Badge variant="destructive" className="text-[10px] py-0">inactive</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">
          {PLATFORM_LABELS[p.platform] ?? p.platform} · {p.rateLimitPerHour}/h
          {p.platform !== "app" && ` · ${p.allowedOrigins.length} origin(s)`}
          {p.webhookUrl && (p.webhookConfigured ? " · webhook (signed)" : " · webhook (unsigned)")}
        </span>
      </div>
      {canWrite && (
        <>
          <Button size="icon-sm" variant="ghost" onClick={startEdit} aria-label="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="gap-1" onClick={onRotate}>
            <KeyRound className="h-3.5 w-3.5" /> Rotate
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setProjectActive(p.id, !p.isActive)}>
            {p.isActive ? "Deactivate" : "Activate"}
          </Button>
        </>
      )}
      {canDelete && (
        <Button size="icon-sm" variant="ghost" className="text-destructive" onClick={onDelete} aria-label="Delete">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

/** One secret the server will never show again. */
interface Once {
  name: string; // also the 1Password field name
  label: string;
  value: string;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Everything created with the project that can't be read back: the ingest key
 * (cac stores only a hash) and the webhook secret (never returned).
 *
 * Offering 1Password here rather than "copy and paste it somewhere" is the
 * point — this is the one moment the values exist outside the server, and what
 * people otherwise do is leave them in a scratch file.
 */
function RevealedSecrets({
  title,
  secrets,
  onDone,
}: {
  title: string;
  secrets: Once[];
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [vault, setVault] = useState("Private");
  const [saving, setSaving] = useState(false);
  const [refs, setRefs] = useState<[string, string][] | null>(null);

  const copy = async (s: Once) => {
    await navigator.clipboard.writeText(s.value);
    setCopied(s.name);
    toast.success(`${s.label} copied`);
  };

  const saveToOnePassword = async () => {
    setSaving(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const out = await invoke<[string, string][]>("op_item_create", {
        title: `cac · ${title}`,
        vault,
        fields: secrets.map((s) => [s.name, s.value]),
      });
      setRefs(out);
      toast.success("Saved to 1Password");
    } catch (e) {
      toast.error("Could not save to 1Password", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          Shown once — these can't be retrieved later, only rotated or replaced.
        </p>
      </div>

      {secrets.map((s) => (
        <div key={s.name} className="space-y-1">
          <Label className="text-xs">{s.label}</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-background px-2 py-1.5 text-xs font-mono break-all">
              {s.value}
            </code>
            <Button size="icon" variant="outline" onClick={() => copy(s)}>
              {copied === s.name ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      ))}

      {refs ? (
        <div className="space-y-1 rounded border bg-background/60 p-2">
          <p className="text-xs font-medium">Saved. Use these references in your deploy config:</p>
          {refs.map(([name, reference]) => (
            <code key={name} className="block text-[11px] font-mono break-all">
              {reference}
            </code>
          ))}
        </div>
      ) : (
        inTauri && (
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">1Password vault</Label>
              <Input
                value={vault}
                onChange={(e) => setVault(e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <Button size="sm" variant="secondary" onClick={saveToOnePassword} disabled={saving}>
              <Lock className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save to 1Password"}
            </Button>
          </div>
        )
      )}

      <Button size="sm" variant="secondary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

