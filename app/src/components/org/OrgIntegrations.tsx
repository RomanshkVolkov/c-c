import { useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, Plus, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ConfirmDialog";
import CopyId from "@/components/CopyId";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import { cn } from "@/lib/utils";

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
  const rotateProjectKey = useReportsStore((s) => s.rotateProjectKey);
  const setProjectActive = useReportsStore((s) => s.setProjectActive);
  const deleteProject = useReportsStore((s) => s.deleteProject);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const confirm = useConfirm();

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

  useEffect(() => {
    fetchProjects().catch(() => {});
  }, [fetchProjects, orgId]);

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
        <p className="text-xs text-muted-foreground">
          Nothing is wired to this organization yet.
        </p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {mios.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className={cn("truncate font-medium", !p.isActive && "text-muted-foreground")}>
                {p.name}
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {p.platform === "app" ? "server" : "browser"}
              </Badge>
              {!p.isActive && (
                <Badge variant="outline" className="text-[10px]">
                  paused
                </Badge>
              )}
              <span className="truncate font-mono text-[11px] text-muted-foreground">{p.slug}</span>
              {p.webhookUrl && (
                <span className="truncate text-[11px] text-muted-foreground">→ {p.webhookUrl}</span>
              )}
              {canManage && (
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title={p.isActive ? "Pause it" : "Resume it"}
                    onClick={() =>
                      setProjectActive(p.id, !p.isActive).catch((e) => toast.error(String(e)))
                    }
                  >
                    <Power className={cn("size-3.5", !p.isActive && "text-muted-foreground")} />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title="Rotate the key"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Rotate the key for "${p.name}"?`,
                        description:
                          "Whatever is using the old key stops being able to post the moment this happens. You get the new one once.",
                        confirmText: "Rotate",
                        destructive: true,
                      });
                      if (!ok) return;
                      try {
                        setClave(await rotateProjectKey(p.id));
                      } catch (e) {
                        toast.error(String(e));
                      }
                    }}
                  >
                    <KeyRound className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title="Delete it"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete "${p.name}"?`,
                        description:
                          "Its channel stops accepting anything. Work already raised through it stays where it is.",
                        confirmText: "Delete",
                        destructive: true,
                      });
                      if (ok) deleteProject(p.id).catch((e) => toast.error(String(e)));
                    }}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
