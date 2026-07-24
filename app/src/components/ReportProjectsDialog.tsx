import { useState } from "react";
import { Plus, KeyRound, Copy, Trash2, Check, Pencil } from "lucide-react";
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
import OriginsEditor, { cleanOrigins } from "@/components/OriginsEditor";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useConfirm } from "@/components/ConfirmDialog";
import { roleAtLeast } from "@/types/organization";
import type { ReportProject } from "@/types/report";

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
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ label: string; key: string } | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const key = await createProject({
        name: name.trim(),
        allowedOrigins: cleanOrigins(origins),
        rateLimitPerHour: Number(rate) || 20,
      });
      setRevealed({ label: `Ingest key for "${name.trim()}"`, key });
      setName("");
      setOrigins([""]);
      setRate("20");
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
      setRevealed({ label: `New ingest key for "${pname}"`, key });
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
          <RevealedKey label={revealed.label} value={revealed.key} onDone={() => setRevealed(null)} />
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
            <OriginsEditor value={origins} onChange={setOrigins} />
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
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setName(p.name);
    setRate(String(p.rateLimitPerHour));
    setOrigins(p.allowedOrigins.length ? p.allowedOrigins : [""]);
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
        <OriginsEditor value={origins} onChange={setOrigins} />
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
          {p.rateLimitPerHour}/h · {p.allowedOrigins.length} origin(s)
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

function RevealedKey({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success("Copied to clipboard");
  };
  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted-foreground">
        Shown once — copy it now. It can't be retrieved later (only rotated).
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-background px-2 py-1.5 text-xs font-mono break-all">{value}</code>
        <Button size="icon" variant="outline" onClick={copy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <Button size="sm" variant="secondary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
