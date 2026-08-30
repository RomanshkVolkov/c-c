import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Inbox, KeyRound, Loader2, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ConfirmDialog";
import CopyId from "@/components/CopyId";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { listasDelArbol, rutaDeLista, type ListaConRuta } from "@/lib/bandeja";
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
  const { t } = useT();
  const projects = useReportsStore((s) => s.projects);
  const fetchProjects = useReportsStore((s) => s.fetchProjects);
  const createProject = useReportsStore((s) => s.createProject);
  const orgId = useOrgsStore((s) => s.currentOrgId);

  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState("");
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

  // El árbol de la organización, para decir dónde caen los reportes con el
  // nombre de la lista y para poder elegir otra. Está en el store porque el
  // navegador lo carga, pero esta pantalla se puede abrir de primeras.
  const tree = useTasksStore((s) => s.tree);
  const fetchTree = useTasksStore((s) => s.fetchTree);

  useEffect(() => {
    fetchProjects().catch(() => {});
  }, [fetchProjects, orgId]);

  // Cada vez que cambia la organización, no sólo si el árbol está vacío.
  //
  // Lo tenía en «si está vacío», y el árbol que quedaba en memoria podía ser de
  // **otra organización**: el navegador lo recarga al cambiar de org, pero en
  // Ajustes no está montado. El panel acababa ofreciendo las listas de otra
  // organización como bandeja de esta integración, y elegir una devolvía
  // `inbox-other-org` sin que nada explicara por qué.
  useEffect(() => {
    void fetchTree();
  }, [orgId, fetchTree]);

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
      // Siempre server-to-server: lo que se integra hoy es otro servidor, no un
      // navegador. Las que ya existan en "web" se siguen leyendo y editando tal
      // cual —el servidor sigue vigilando sus orígenes— pero no se crean más.
      const key = await createProject({
        name: n,
        platform: "app",
        // Nadie manda Origin desde un servidor, así que la lista se queda vacía
        // en vez de guardar algo que no se comprueba nunca.
        allowedOrigins: [],
      });
      setNombre("");
      setCreando(false);
      setClave(key);
    } catch (e) {
      toast.error(t("org:errCreate"), { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      {clave && (
        <div className="rounded border border-warning/50 bg-warning/10 p-3 text-xs">
          <p className="font-medium">{t("org:keyShownOnce")}</p>
          <p className="mt-1 text-muted-foreground">
            {t("org:keyHashOnly")}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono">
              {clave}
            </code>
            <CopyId id={clave} label="key" />
            <Button size="sm" variant="ghost" onClick={() => setClave(null)}>
              {t("org:iSavedIt")}
            </Button>
          </div>
        </div>
      )}

      {/* Lo que hay que saber antes de crear una, no después: de dónde llega
          esto y cuándo se puede leer la llave. */}
      <p className="max-w-[660px] text-xs leading-relaxed text-muted-foreground">
        Each integration receives reports from an external system, server to server: it
        holds an ingest key and sends no Origin, so the key is the whole of it. The key
        is shown once — when it is created, and when it is rotated.
      </p>

      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">{t("org:reportProjects")}</Label>
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
            placeholder={t("org:integrationNamePlaceholder")}
            className="max-w-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t("org:noOriginChecked")}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={crear} disabled={!nombre.trim() || busy}>
              {busy && <Loader2 className="mr-1 size-3 animate-spin" />} {t("org:create")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreando(false)}>
              {t("org:cancel")}
            </Button>
          </div>
        </div>
      )}

      {mios.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          {t("org:nothingWired")}
        </p>
      ) : (
        <ul className="space-y-3">
          {mios.map((p) => (
            <FichaIntegracion
              key={p.id}
              proyecto={p}
              canManage={canManage}
              miembros={miembros}
              listas={listasDelArbol(tree, p.orgId)}
              ruta={rutaDeLista(tree, p.listId)}
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
  listas,
  ruta,
  onRotated,
}: {
  proyecto: ReportProject;
  canManage: boolean;
  miembros: OrgMember[];
  /** Las listas de la organización, para poder elegir bandeja. */
  listas: ListaConRuta[];
  /** La ruta de la bandeja de hoy, o `null` si no es de esta organización. */
  ruta: string | null;
  onRotated: (clave: string) => void;
}) {
  const { t } = useT();
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
    listId: p.listId ?? "",
  });

  const responsable = miembros.find((m) => m.userId === p.defaultAssigneeUserId);

  /**
   * Guardar manda **sólo lo que cambió**.
   *
   * Antes mandaba el formulario entero cada vez, porque el servidor borraba lo
   * que no viajara y había que reenviarlo todo para conservarlo. Eso hacía que
   * dos personas editando a la vez se pisaran campos que ninguna había tocado, y
   * que un `Number("")` mal parado reiniciara un límite de paso. Ya no: omitir
   * un campo lo deja como está, así que lo que no se toca no se manda.
   *
   * Borrar sigue siendo posible y sigue siendo explícito: vaciar la caja del
   * webhook manda `""`, que sí lo retira. Lo que no puede pasar es borrar algo
   * sin haberlo pedido.
   */
  const guardar = async () => {
    const cambios: Parameters<typeof updateProject>[1] = {};
    const nombre = borrador.name.trim();
    if (nombre && nombre !== p.name) cambios.name = nombre;

    if (p.platform === "web") {
      const origenes = borrador.allowedOrigins.split(",").map((o) => o.trim()).filter(Boolean);
      if (origenes.join(",") !== p.allowedOrigins.join(",")) cambios.allowedOrigins = origenes;
    }
    const porHora = Number(borrador.rateLimitPerHour);
    if (porHora > 0 && porHora !== p.rateLimitPerHour) cambios.rateLimitPerHour = porHora;
    const porReportero = Number(borrador.rateLimitPerReporterPerHour);
    if (porReportero > 0 && porReportero !== p.rateLimitPerReporterPerHour) {
      cambios.rateLimitPerReporterPerHour = porReportero;
    }

    if (borrador.webhookUrl.trim() !== (p.webhookUrl ?? "")) {
      cambios.webhookUrl = borrador.webhookUrl.trim();
    }
    // El secreto sólo viaja cuando hay uno nuevo: en blanco significa «deja el
    // que hay», no «deja de firmar».
    if (borrador.webhookSecret) cambios.webhookSecret = borrador.webhookSecret;

    if (borrador.defaultAssigneeUserId !== (p.defaultAssigneeUserId ?? "")) {
      cambios.defaultAssigneeUserId = borrador.defaultAssigneeUserId;
    }
    // La bandeja no se puede vaciar —el servidor lo rechaza, porque un canal sin
    // lista pierde todo lo que le manden— así que sólo se cambia por otra.
    if (borrador.listId && borrador.listId !== (p.listId ?? "")) cambios.listId = borrador.listId;

    if (Object.keys(cambios).length === 0) {
      setEditando(false);
      return;
    }
    setGuardando(true);
    try {
      await updateProject(p.id, cambios);
      setEditando(false);
    } catch (e) {
      toast.error(t("org:errSave"), { description: String(e) });
    } finally {
      setGuardando(false);
    }
  };

  const rotar = async () => {
    const ok = await confirm({
      title: `Rotate the key for "${p.name}"?`,
      description:
        t("org:rotateBody"),
      confirmText: t("org:rotate"),
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
        t("org:deleteIntegrationBody"),
      confirmText: t("org:delete"),
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
          {t("common:count.reportsThisMonth", { count: p.reportsThisMonth ?? 0 })}
        </span>
      </div>

      {editando ? (
        <div className="space-y-2 px-3.5 py-3">
          <Input
            autoFocus
            value={borrador.name}
            onChange={(e) => setBorrador({ ...borrador, name: e.target.value })}
            placeholder={t("org:namePlaceholder")}
            className="max-w-sm"
          />
          {p.platform === "web" && (
            <Input
              value={borrador.allowedOrigins}
              onChange={(e) => setBorrador({ ...borrador, allowedOrigins: e.target.value })}
              placeholder={t("org:originsPlaceholder")}
              className="max-w-lg text-xs"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <label className="text-xs text-muted-foreground">
              {t("org:perHour")}
              <Input
                value={borrador.rateLimitPerHour}
                onChange={(e) => setBorrador({ ...borrador, rateLimitPerHour: e.target.value })}
                className="mt-1 h-8 w-28 text-xs"
                inputMode="numeric"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              {t("org:perReporter")}
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
              {t("org:webhook")}
              <Input
                value={borrador.webhookUrl}
                onChange={(e) => setBorrador({ ...borrador, webhookUrl: e.target.value })}
                placeholder={t("org:webhookPlaceholder")}
                className="mt-1 h-8 text-xs"
              />
            </label>
            <label className="min-w-48 flex-1 text-xs text-muted-foreground">
              {p.webhookConfigured ? t("org:replaceSecret") : t("org:signingSecret")}
              <Input
                type="password"
                value={borrador.webhookSecret}
                onChange={(e) => setBorrador({ ...borrador, webhookSecret: e.target.value })}
                placeholder={p.webhookConfigured ? "leave blank to keep it" : "optional"}
                className="mt-1 h-8 text-xs"
              />
            </label>
            <label className="min-w-56 flex-1 text-xs text-muted-foreground">
              {t("org:reportsArriveIn")}
              <select
                value={borrador.listId}
                onChange={(e) => setBorrador({ ...borrador, listId: e.target.value })}
                className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
              >
                {/* Sin opción de «ninguna»: quitarla no desconfigura la
                    integración, hace que todo lo que le manden se pierda sin
                    decir nada. Se cambia por otra lista o se queda. */}
                {!p.listId && <option value="">— pick a list —</option>}
                {listas.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.ruta}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-48 flex-1 text-xs text-muted-foreground">
              {t("org:defaultAssignee")}
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
              {t("org:cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <dl className="grid gap-2 px-3.5 py-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">{t("org:ingestKey")}</dt>
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
              {p.platform === "web" ? t("org:allowedOrigins") : t("org:origin")}
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
            <dt className="uppercase tracking-wide text-muted-foreground">{t("org:limits")}</dt>
            <dd className="mt-0.5">
              {p.rateLimitPerHour}/h in total · {p.rateLimitPerReporterPerHour}/h per reporter
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">{t("org:webhook")}</dt>
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
          {/* Lo primero que se pregunta de una integración y lo único que no se
              podía ver: dónde acaba lo que manda. */}
          <div>
            <dt className="flex items-center gap-1 uppercase tracking-wide text-muted-foreground">
              <Inbox className="size-3" /> Reports arrive in
            </dt>
            <dd className="mt-0.5">
              {ruta ? (
                <span className="font-medium">{ruta}</span>
              ) : p.listId ? (
                // Hay bandeja, pero no es de esta organización o ya no existe.
                // Decirlo es mejor que pintar el uuid que se pintaba antes.
                <span className="text-warning">a list outside this organization</span>
              ) : (
                <span className="text-destructive">
                  nowhere — anything it sends is being lost
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">{t("org:defaultAssignee")}</dt>
            <dd className="mt-0.5">
              {responsable ? `@${responsable.username}` : (
                <span className="text-muted-foreground">nobody</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-muted-foreground">{t("org:created")}</dt>
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
              <Power className="mr-1 size-3" /> {p.isActive ? t("org:pause") : t("org:resume")}
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
