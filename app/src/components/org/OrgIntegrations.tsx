import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ConfirmDialog";
import CopyId from "@/components/CopyId";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import { cn } from "@/lib/utils";
import { desde } from "@/lib/desde";
import type { ReportProject } from "@/types/report";
import type { OrgMember } from "@/types/organization";

/**
 * What this organization is wired to: its report projects.
 *
 * These are the server-to-server integrations — another system holds an ingest
 * key and pushes work in, and everything it sends lands in a list here. They
 * belong to the organization, which is why they live on this screen and not on
 * a server's.
 */
export default function OrgIntegrations({ canManage }: { canManage: boolean }) {
  const projects = useReportsStore((s) => s.projects);
  const fetchProjects = useReportsStore((s) => s.fetchProjects);
  const createProject = useReportsStore((s) => s.createProject);
  const orgId = useOrgsStore((s) => s.currentOrgId);

  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState("");
  const [plataforma, setPlataforma] = useState<"app" | "web">("app");
  const [origenes, setOrigenes] = useState("");
  const [busy, setBusy] = useState(false);
  /**
   * The key, shown once.
   *
   * The server hands it over at creation and at rotation and never again — it
   * keeps a hash and nothing else — so this really is the only moment it exists
   * in readable form. Held in state and announced as such rather than put in a
   * toast that vanishes while somebody is reaching for their password manager.
   */
  const [clave, setClave] = useState<string | null>(null);

  // Los miembros, para poder nombrar al responsable por defecto y para poder
  // elegirlo: un id crudo en la ficha no le dice nada a nadie.
  const listMembers = useOrgsStore((s) => s.listMembers);
  const [miembros, setMiembros] = useState<OrgMember[]>([]);

  useEffect(() => {
    fetchProjects().catch(() => {});
  }, [fetchProjects, orgId]);

  useEffect(() => {
    if (!orgId) return;
    listMembers(orgId).then(setMiembros).catch(() => {});
  }, [orgId, listMembers]);

  const mios = projects.filter((p) => !orgId || p.orgId === orgId);

  const crear = async () => {
    const n = nombre.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const key = await createProject({
        name: n,
        platform: plataforma,
        // Only "web" polices the Origin header; a server-to-server caller sends
        // none, so the list stays empty rather than holding something that is
        // never checked.
        allowedOrigins:
          plataforma === "web"
            ? origenes.split(",").map((o) => o.trim()).filter(Boolean)
            : [],
      });
      setNombre("");
      setOrigenes("");
      setCreando(false);
      setClave(key);
    } catch (e) {
      toast.error("Could not create it", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      {clave && (
        <div className="rounded border border-warning/50 bg-warning/10 p-3 text-xs">
          <p className="font-medium">This is the only time this key is shown. Save it now.</p>
          <p className="mt-1 text-muted-foreground">
            The server keeps a hash of it and nothing else, so it cannot be read back —
            losing it means rotating and updating whatever was using it.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono">
              {clave}
            </code>
            <CopyId id={clave} label="key" />
            <Button size="sm" variant="ghost" onClick={() => setClave(null)}>
              I saved it
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">Report projects</Label>
        {canManage && !creando && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setCreando(true)}>
            <Plus className="mr-1 size-3" /> New
          </Button>
        )}
      </div>

      {creando && (
        <div className="space-y-2 rounded-xl border bg-card p-3">
          <Input
            autoFocus
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Name — the client or system this is for"
            className="max-w-sm"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              aria-label="Kind"
              value={plataforma}
              onChange={(e) => setPlataforma(e.target.value as "app" | "web")}
              className="h-8 rounded border bg-background px-2"
            >
              <option value="app">Server to server</option>
              <option value="web">From a browser</option>
            </select>
            {plataforma === "web" && (
              <Input
                value={origenes}
                onChange={(e) => setOrigenes(e.target.value)}
                placeholder="https://one.example, https://two.example"
                className="h-8 max-w-sm text-xs"
              />
            )}
            <span className="text-muted-foreground">
              {plataforma === "web"
                ? "Only these origins may post; a browser sends one and it is checked."
                : "No origin is checked — a server sends none. The key is the whole of it."}
            </span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={crear} disabled={!nombre.trim() || busy}>
              {busy && <Loader2 className="mr-1 size-3 animate-spin" />} Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreando(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mios.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          Nothing is wired to this organization yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {mios.map((p) => (
            <FichaIntegracion
              key={p.id}
              proyecto={p}
              canManage={canManage}
              miembros={miembros}
              onRotated={setClave}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Lo que una integración es, sin tener que abrir nada. */
function FichaIntegracion({
  proyecto: p,
  canManage,
  miembros,
  onRotated,
}: {
  proyecto: ReportProject;
  canManage: boolean;
  miembros: OrgMember[];
  onRotated: (clave: string) => void;
}) {
  const confirm = useConfirm();
  const updateProject = useReportsStore((s) => s.updateProject);
  const rotateProjectKey = useReportsStore((s) => s.rotateProjectKey);
  const setProjectActive = useReportsStore((s) => s.setProjectActive);
  const deleteProject = useReportsStore((s) => s.deleteProject);

  const [editando, setEditando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [borrador, setBorrador] = useState({
    name: p.name,
    allowedOrigins: p.allowedOrigins.join(", "),
    rateLimitPerHour: String(p.rateLimitPerHour),
    rateLimitPerReporterPerHour: String(p.rateLimitPerReporterPerHour),
    webhookUrl: p.webhookUrl ?? "",
    webhookSecret: "",
    defaultAssigneeUserId: p.defaultAssigneeUserId ?? "",
  });

  const responsable = miembros.find((m) => m.userId === p.defaultAssigneeUserId);

  const guardar = async () => {
    setGuardando(true);
    try {
      await updateProject(p.id, {
        name: borrador.name.trim() || p.name,
        allowedOrigins:
          p.platform === "web"
            ? borrador.allowedOrigins.split(",").map((o) => o.trim()).filter(Boolean)
            : [],
        rateLimitPerHour: Number(borrador.rateLimitPerHour) || p.rateLimitPerHour,
        rateLimitPerReporterPerHour:
          Number(borrador.rateLimitPerReporterPerHour) || p.rateLimitPerReporterPerHour,
        isActive: p.isActive,
        webhookUrl: borrador.webhookUrl.trim(),
        // Vacío significa «no lo toques»: mandarlo en blanco borraría el que ya
        // hay, y nadie que sólo venía a cambiar el nombre espera eso.
        ...(borrador.webhookSecret ? { webhookSecret: borrador.webhookSecret } : {}),
        // "" lo quita; el servidor distingue vacío de ausente aquí.
        defaultAssigneeUserId: borrador.defaultAssigneeUserId,
      });
      setEditando(false);
    } catch (e) {
      toast.error("Could not save it", { description: String(e) });
    } finally {
      setGuardando(false);
    }
  };

  const rotar = async () => {
    const ok = await confirm({
      title: `Rotate the key for "${p.name}"?`,
      description:
        "Whatever is using the old key stops being able to post the moment this happens. You get the new one once.",
      confirmText: "Rotate",
      destructive: true,
    });
    if (!ok) return;
    try {
      onRotated(await rotateProjectKey(p.id));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const borrar = async () => {
    const ok = await confirm({
      title: `Delete "${p.name}"?`,
      description:
        "Its channel stops accepting anything. Work already raised through it stays where it is.",
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) deleteProject(p.id).catch((e) => toast.error(String(e)));
  };

  return (
    <li className={cn("rounded-xl border bg-card", !p.isActive && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3.5 py-3">
        <span className={cn("truncate font-medium", !p.isActive && "text-muted-foreground")}>
          {p.name}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{p.slug}</span>
        <Badge variant="secondary" className="text-[10px]">
          {p.platform === "app" ? "server to server" : "from a browser"}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {p.isActive ? "active" : "paused"}
        </Badge>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {p.reportsThisMonth ?? 0} report{(p.reportsThisMonth ?? 0) === 1 ? "" : "s"} this month
        </span>
      </div>

      {editando ? (
        <div className="space-y-2 px-3.5 py-3">
          <Input
            autoFocus
            value={borrador.name}
            onChange={(e) => setBorrador({ ...borrador, name: e.target.value })}
            placeholder="Name"
            className="max-w-sm"
          />
          {p.platform === "web" && (
            <Input
              value={borrador.allowedOrigins}
              onChange={(e) => setBorrador({ ...borrador, allowedOrigins: e.target.value })}
              placeholder="https://one.example, https://two.example"
              className="max-w-lg text-xs"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <label className="text-xs text-muted-foreground">
              Per hour
              <Input
                value={borrador.rateLimitPerHour}
                onChange={(e) => setBorrador({ ...borrador, rateLimitPerHour: e.target.value })}
                className="mt-1 h-8 w-28 text-xs"
                inputMode="numeric"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Per reporter
              <Input
                value={borrador.rateLimitPerReporterPerHour}
                onChange={(e) =>
                  setBorrador({ ...borrador, rateLimitPerReporterPerHour: e.target.value })
                }
                className="mt-1 h-8 w-28 text-xs"
                inputMode="numeric"
              />
            </label>
            <label className="min-w-56 flex-1 text-xs text-muted-foreground">
              Webhook
              <Input
                value={borrador.webhookUrl}
                onChange={(e) => setBorrador({ ...borrador, webhookUrl: e.target.value })}
                placeholder="https://example.com/hooks/cac"
                className="mt-1 h-8 text-xs"
              />
            </label>
            <label className="min-w-48 flex-1 text-xs text-muted-foreground">
              {p.webhookConfigured ? "Replace the signing secret" : "Signing secret"}
              <Input
                type="password"
                value={borrador.webhookSecret}
                onChange={(e) => setBorrador({ ...borrador, webhookSecret: e.target.value })}
                placeholder={p.webhookConfigured ? "leave blank to keep it" : "optional"}
                className="mt-1 h-8 text-xs"
              />
            </label>
            <label className="min-w-48 flex-1 text-xs text-muted-foreground">
              Default assignee
              <select
                value={borrador.defaultAssigneeUserId}
                onChange={(e) =>
                  setBorrador({ ...borrador, defaultAssigneeUserId: e.target.value })
                }
                className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
              >
                <option value="">nobody</option>
                {miembros.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    @{m.username}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={guardar} disabled={guardando}>
              {guardando && <Loader2 className="mr-1 size-3 animate-spin" />} Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditando(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <dl className="grid gap-2 px-3.5 py-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">Ingest key</dt>
            <dd className="mt-0.5 flex items-center gap-2">
              <span className="text-muted-foreground">
                shown once, when created or rotated
              </span>
              {canManage && (
                <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={rotar}>
                  <KeyRound className="mr-1 size-3" /> Rotate
                </Button>
              )}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">
              {p.platform === "web" ? "Allowed origins" : "Origin"}
            </dt>
            <dd className="mt-0.5 break-words">
              {p.platform === "web"
                ? p.allowedOrigins.length > 0
                  ? p.allowedOrigins.join(", ")
                  : "none — nothing can post until one is listed"
                : "not checked; a server sends none. The key is the whole of it."}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">Limits</dt>
            <dd className="mt-0.5">
              {p.rateLimitPerHour}/h in total · {p.rateLimitPerReporterPerHour}/h per reporter
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">Webhook</dt>
            <dd className="mt-0.5 break-all">
              {p.webhookUrl ? (
                <>
                  {p.webhookUrl}
                  <span className="text-muted-foreground">
                    {p.webhookConfigured ? " · signed" : " · unsigned"}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">Default assignee</dt>
            <dd className="mt-0.5">
              {responsable ? `@${responsable.username}` : (
                <span className="text-muted-foreground">nobody</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">Created</dt>
            <dd className="mt-0.5">{desde(p.createdAt)}</dd>
          </div>
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t px-3.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          POST /api/v1/reports/ingest · X-Ingest-Key
        </code>
        {canManage && !editando && (
          <span className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditando(true)}>
              <Pencil className="mr-1 size-3" /> Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setProjectActive(p.id, !p.isActive).catch((e) => toast.error(String(e)))
              }
            >
              <Power className="mr-1 size-3" /> {p.isActive ? "Pause" : "Resume"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={borrar}
            >
              <Trash2 className="mr-1 size-3" /> Delete
            </Button>
          </span>
        )}
      </div>
    </li>
  );
}
