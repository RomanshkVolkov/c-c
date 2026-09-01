import { fechaYHora } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Loader2,
  Flag,
  Tag as TagIcon,
  Trash2,
  Eye,
  EyeOff,
  Check,
  Paperclip,
  Send,
  Calendar,
  Users,
  Pencil,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { fileCrash, rutaActual, signature, type Fichado } from "@/lib/file-crash";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import Markdown from "@/components/markdown/Markdown";
import UserPicker from "@/components/UserPicker";
import { useConfirm } from "@/components/ConfirmDialog";
import { usePrompt } from "@/components/PromptDialog";
import { mediaSrc, openAttachment } from "@/lib/media";
import Lightbox from "@/components/Lightbox";
import PdfPreview from "@/components/PdfPreview";
import CopyId from "@/components/CopyId";
import TelemetryTimeline from "@/components/TelemetryTimeline";
import { commentByline } from "@/lib/byline";
import { describeAgent } from "@/lib/user-agent";
import { useTasksStore } from "@/store/tasks.store";
import { usePeopleStore } from "@/store/people.store";
import { mentionsAllowed } from "@/components/markdown/mention-scope";
import { useAuthStore } from "@/store/auth.store";
import { PRIORITIES, priorityMeta } from "@/types/task";
import type { TaskStatus } from "@/types/task";
import type { TaskComment } from "@/types/task";
import { cn } from "@/lib/utils";

/**
 * Task detail: title, status, priority, tags, assignees, dates, a markdown
 * description with inline attachments, and the comment thread.
 *
 * Description edits are explicit (Edit → Save) rather than autosaved: this is a
 * rich editor, and silently persisting every keystroke would fight the board's
 * refresh cycle and make an accidental paste permanent.
 */
export default function TaskDetailDrawer() {
  const openTaskId = useTasksStore((s) => s.openTaskId);
  const detail = useTasksStore((s) => s.detail);
  const detailError = useTasksStore((s) => s.detailError);
  const loading = useTasksStore((s) => s.loadingDetail);
  const closeTask = useTasksStore((s) => s.closeTask);

  // Escape closes it. It used to be the click-away layer that did that job
  // implicitly; full screen leaves nothing beside it to click, so the keyboard
  // way out has to be explicit or the only exit is one small button.
  useEffect(() => {
    if (!openTaskId) return;
    const onKey = (e: KeyboardEvent) => {
      // Not while typing: Escape in an editor cancels what you are writing, and
      // taking the whole screen away instead would lose it.
      const el = document.activeElement;
      const escribiendo =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "Escape" && !escribiendo) closeTask();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTaskId, closeTask]);

  if (!openTaskId) return null;

  return (
    <>
      {/* Full screen rather than a drawer over the board.
          A task is where work gets described, argued about and decided, and for
          that it needs the room. The properties moved to a rail of their own so
          the reading column stays a reading column. Closing is still the header
          button — the click-away layer is gone, because there is nothing left
          beside it to click away to. */}
      <aside className="fixed inset-0 z-50 flex flex-col bg-background">
        {loading && !detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading task…
          </div>
        ) : !detail ? (
          <CouldNotOpen id={openTaskId} reason={detailError} onClose={closeTask} />
        ) : (
          <Content />
        )}
      </aside>
    </>
  );
}

/**
 * One comment, editable in place by its author (or a superadmin — the same rule
 * the backend enforces, so the affordance never appears where the call would be
 * refused).
 */
function CommentItem({
  comment: c,
  taskId,
  onUpload,
  clientReads,
}: {
  comment: TaskComment;
  taskId: string;
  onUpload: (file: File) => Promise<{ url: string; fileName: string } | null>;
  /** Whether this card's thread is one a client can read at all. */
  clientReads: boolean;
}) {
  const { t } = useT();
  const session = useAuthStore((s) => s.session);
  const editComment = useTasksStore((s) => s.editComment);
  const deleteComment = useTasksStore((s) => s.deleteComment);
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const [saving, setSaving] = useState(false);

  const mine = session?.id === c.authorUserId || !!session?.superadmin;
  const edited = new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000;

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    try {
      await editComment(taskId, c.id, body);
      setEditing(false);
    } catch (e) {
      toast.error(t("work:task.errSaveComment"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  // Only worth saying on a card the client can read: everywhere else every
  // comment is internal, and a badge on all of them says nothing.
  const internal = clientReads && c.visibility === "internal";

  return (
    <div
      className={cn(
        "group rounded-md border p-2.5",
        internal && "border-dashed bg-muted/40",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{commentByline(c.author, c.authorName)}</span>
        <span>{fechaYHora(c.createdAt)}</span>
        {edited && <span className="italic">{t("work:task.edited")}</span>}
        {clientReads && (
          <span
            className={cn("flex items-center gap-1", internal ? "text-muted-foreground" : "text-primary")}
            title={
              internal
                ? t("work:task.onlyTeam")
                : t("work:task.clientCanRead")
            }
          >
            {internal ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            {internal ? t("work:task.internal") : t("work:task.clientSees")}
          </span>
        )}
        {mine && !editing && (
          <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              className="hover:text-foreground"
              title={t("work:task.editComment")}
              onClick={() => {
                setDraft(c.body);
                setEditing(true);
              }}
            >
              <Pencil className="size-3" />
            </button>
            <button
              className="hover:text-destructive"
              title={t("work:task.deleteComment")}
              onClick={async () => {
                const ok = await confirm({
                  title: t("work:task.deleteCommentTitle"),
                  description: t("work:task.deleteCommentBody"),
                  confirmText: t("work:task.delete"),
                  destructive: true,
                });
                if (!ok) return;
                deleteComment(taskId, c.id).catch((e) => toast.error(String(e)));
              }}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            onUpload={onUpload}
            minHeight="4rem"
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving || !draft.trim()}>
              {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
              {t("work:task.save")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              {t("work:task.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Markdown>{c.body}</Markdown>
      )}
    </div>
  );
}

function Content() {
  const { t } = useT();
  const detail = useTasksStore((s) => s.detail)!;
  const closeTask = useTasksStore((s) => s.closeTask);
  const updateTask = useTasksStore((s) => s.updateTask);
  const deleteTask = useTasksStore((s) => s.deleteTask);
  const addComment = useTasksStore((s) => s.addComment);
  // Colleagues for `@`. Fetched here rather than per keystroke: a team is small
  // and the picker has to answer while somebody is mid-word.
  const fetchPeople = usePeopleStore((s) => s.fetchPeople);
  const people = useCallback(() => usePeopleStore.getState().current(), []);
  useEffect(() => {
    fetchPeople().catch(() => {});
  }, [fetchPeople]);
  const uploadAttachment = useTasksStore((s) => s.uploadAttachment);
  const deleteAttachment = useTasksStore((s) => s.deleteAttachment);
  const moveTask = useTasksStore((s) => s.moveTask);
  const tags = useTasksStore((s) => s.tags);
  const openTask = useTasksStore((s) => s.openTask);
  const createSubtask = useTasksStore((s) => s.createSubtask);
  const createTag = useTasksStore((s) => s.createTag);
  const confirm = useConfirm();
  const prompt = usePrompt();

  const { task } = detail;
  const [title, setTitle] = useState(task.title);
  const [editingDesc, setEditingDesc] = useState(false);
  // The columns of *this task's* list. Reading `board.statuses` meant reading
  // whichever board happened to be open, so opening a task from "my work" or
  // from a notification showed an empty menu — a control that looked like a
  // label and did nothing.
  const statusesOf = useTasksStore((s) => s.statusesOf);
  const [columnas, setColumnas] = useState<TaskStatus[]>([]);
  // Y por qué no se pudieron cargar, si no se pudieron.
  //
  // El `.catch(() => {})` que había aquí se tragó durante semanas un 405: la
  // ruta `GET /task-lists/{id}/statuses` no existía —sólo el POST del mismo
  // camino, y por eso 405 y no 404—, así que el menú se abría **vacío** y
  // cambiar el estado desde el detalle era imposible sin un solo error en
  // pantalla. Un fallo que no se ve es un fallo que dura.
  const [fallo, setFallo] = useState<string | null>(null);
  useEffect(() => {
    if (!detail?.task.listId) return;
    let vivo = true;
    setFallo(null);
    statusesOf(detail.task.listId)
      .then((c) => {
        if (!vivo) return;
        setColumnas(c);
        if (c.length === 0) setFallo(t("common:crash.noColumns"));
      })
      .catch((e) => vivo && setFallo(String(e)));
    return () => {
      vivo = false;
    };
  }, [detail?.task.listId, statusesOf]);

  const [pdf, setPdf] = useState<{ url: string; fileName: string } | null>(null);
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);

  /**
   * Qué adjunto es una imagen.
   *
   * Por el `contentType` que declaró quien lo subió, y por la extensión cuando
   * no viene — que es **siempre** en lo que llega por la integración: el ingest
   * de imágenes no escribe el tipo, y el campo es `omitempty`, así que el
   * servidor ni siquiera manda la clave.
   *
   * Ambos con respaldo, y no por prudencia: la primera versión de esto llamaba
   * a `.startsWith` directamente sobre un `contentType` que el tipo prometía
   * `string`. Tumbó la pantalla de tareas entera. El test lo daba por bueno
   * porque su fixture usaba `""` — un campo vacío, no un campo que no está.
   */
  const esImagen = (a: { contentType?: string; fileName?: string }) =>
    (a.contentType ?? "").startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.fileName ?? "");
  const imagenes = detail.attachments.filter(esImagen);
  const otros = detail.attachments.filter((a) => !esImagen(a));

  /** Quitar un adjunto, desde la miniatura o desde la lista. */
  const quitar = async (a: { id: string; fileName: string }) => {
    const inUse = task.description.includes(a.id);
    const ok = await confirm({
      title: t("work:task.removeAttachmentTitle", { name: a.fileName }),
      description: inUse
        ? t("work:task.removeAttachmentInUse")
        : t("work:task.removeAttachmentPlain"),
      confirmText: t("work:task.remove"),
      destructive: true,
    });
    if (!ok) return;
    deleteAttachment(task.id, a.id).catch((e) => toast.error(String(e)));
  };
  const [draft, setDraft] = useState(task.description);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  // Re-sync only when the drawer switches to *another* task.
  //
  // The id alone, on purpose. With `task.title` and `task.description` in here
  // too, any refetch of the same task — adding a subtask, a comment, an
  // attachment, a live update from someone else — overwrote whatever was being
  // typed with the copy the server had. Losing a half-written description to a
  // background refresh is far worse than showing a slightly stale title while
  // the field is focused.
  useEffect(() => {
    setTitle(task.title);
    setDraft(task.description);
    setEditingDesc(false);
    setComment("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const orgTags = useMemo(() => tags.filter((t) => t.orgId === task.orgId), [tags, task.orgId]);

  // Resolve "done"/"open" through the columns' `kind`, never their names: the
  // user is free to rename them.
  //
  // From this task's own list, for the same reason the status menu is: reading
  // the open board meant ticking a subtask did nothing at all when the detail
  // was opened from anywhere but the board it belongs to.
  const doneStatusIds = useMemo(
    () => new Set(columnas.filter((s) => s.kind === "done").map((s) => s.id)),
    [columnas],
  );
  const firstDoneStatusId = columnas.find((s) => s.kind === "done")?.id ?? "";
  const firstOpenStatusId = columnas.find((s) => s.kind !== "done")?.id ?? "";
  const tagIds = new Set(detail.tags.map((t) => t.id));

  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === task.title) return;
    updateTask(task.id, { title: next }).catch((e) => toast.error(String(e)));
  };

  const upload = async (file: File) => uploadAttachment(task.id, file);

  // On a card a client can read, the composer says who it is talking to and the
  // choice is one click away. Public by default — the thread on their board and
  // the one here have to be the same conversation, or both are misleading.
  const clientReads = Boolean(task.projectId) && task.visibility !== "internal";
  const [commentInternal, setCommentInternal] = useState(false);
  // El cliente puede leer esto, pero **no hay a quién avisar**.
  //
  // El webhook sale igual; lo que no hay es destinatario. Los receptores
  // enrutan el aviso por `reporterId` —el contrato lo dice así en §5.b— y un
  // reporte que levantamos nosotros no tiene reporter, así que el evento llega
  // y no notifica a nadie.
  //
  // Se dice **antes** de escribir y no al enviar: la decisión de si esto es el
  // sitio adecuado se toma con el cursor en blanco, no con tres párrafos ya
  // redactados. Costó una explicación larga esperando respuesta tres días.
  //
  // Con el comentario en modo interno no se enseña: ahí nadie espera aviso.
  const sinDestinatario = clientReads && !commentInternal && !task.reporterId;

  const send = async () => {
    const body = comment.trim();
    if (!body) return;
    setSending(true);
    try {
      await addComment(task.id, body, clientReads && commentInternal ? "internal" : undefined);
      setComment("");
    } catch (e) {
      toast.error(t("work:task.errComment"), { description: String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {pdf && <PdfPreview {...pdf} onClose={() => setPdf(null)} />}
      {zoom && <Lightbox {...zoom} onClose={() => setZoom(null)} />}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="truncate text-xs text-muted-foreground">
          {detail.spaceName} / {detail.listName}
          {detail.parent && (
            <>
              {" / "}
              <button
                className="underline hover:text-foreground"
                onClick={() => openTask(detail.parent!.id)}
                title={t("work:task.openParent")}
              >
                #{detail.parent.seq} {detail.parent.title}
              </button>
            </>
          )}
          {/* The number reads best beside the space it belongs to. When this
              is a client's ticket the same chip copies the whole folio —
              "portento-97" — which is what gets quoted in a message or handed
              to an agent, and what the MCP tools resolve. */}
          {!detail.folio && ` · #${task.seq}`}
        </span>
        {detail.folio && (
          <CopyId id={detail.folio} label="folio" display={`#${task.seq}`} />
        )}
        {/* Whether a client is reading this, said plainly and next to the title.
            Someone about to type a frank note needs to know before they type it,
            not after. */}
        {task.projectId && task.visibility !== "internal" && (
          <span className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
            <Eye className="size-3" /> {t("work:task.visibleToClient")}
          </span>
        )}
        {/* The id the MCP tools take, so it can be handed to an agent. */}
        <CopyId id={task.id} label="task" />
        <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={closeTask} aria-label={t("work:task.close")}>
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 space-y-5 overflow-auto p-4 lg:px-8">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-auto border-0 px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
        />

        {/* Description */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("work:task.description")}
            </h3>
            {!editingDesc && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditingDesc(true)}>
                {t("work:task.edit")}
              </Button>
            )}
          </div>
          {editingDesc ? (
            <div className="space-y-2">
              <MarkdownEditor
                value={draft}
                onChange={setDraft}
                onUpload={upload}
                minHeight="10rem"
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    updateTask(task.id, { description: draft })
                      .then(() => setEditingDesc(false))
                      .catch((e) => toast.error(String(e)));
                  }}
                >
                  {t("work:task.save")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(task.description);
                    setEditingDesc(false);
                  }}
                >
                  {t("work:task.cancel")}
                </Button>
              </div>
            </div>
          ) : task.description ? (
            <Markdown>{task.description}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">{t("work:task.noDescription")}</p>
          )}
        </section>

        {/* Attachments attached to the task itself */}
        {detail.attachments.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("work:task.attachments")}
            </h3>
            {/* Las imágenes se ven, no se listan.
                
                En un reporte de cliente la captura **es** el reporte, y hasta
                ahora salía como una línea con un clip que había que abrir en
                otro programa — una por una. La app ya sabía pintar una imagen
                autenticada con zoom, pero sólo dentro del cuerpo en markdown; lo
                que llega de un cliente entra como adjunto de galería y se
                quedaba fuera de ese camino. */}
            {imagenes.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {imagenes.map((a) => {
                  const src = mediaSrc(a.url);
                  return (
                    <li key={a.id} className="group/img relative">
                      <button
                        onClick={() => src && setZoom({ src, alt: a.fileName })}
                        title={a.fileName}
                        className="block cursor-zoom-in overflow-hidden rounded-md border"
                      >
                        <img
                          src={src}
                          alt={a.fileName}
                          loading="lazy"
                          className="max-h-40 max-w-64 object-contain"
                        />
                      </button>
                      <button
                        className="absolute right-1 top-1 rounded bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity group-hover/img:opacity-100 hover:text-destructive"
                        title={t("work:task.removeAttachment")}
                        onClick={() => void quitar(a)}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <ul className="space-y-1">
              {otros.map((a) => (
                <li key={a.id} className="group flex items-center gap-2 text-xs">
                  <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                  <button
                    className="truncate text-left text-primary underline"
                    // Same rule as a link in the body: a PDF stays in the app,
                    // anything else goes to the program that understands it.
                    onClick={() => {
                      if (/\.pdf$/i.test(a.fileName)) {
                        setPdf({ url: a.url, fileName: a.fileName });
                        return;
                      }
                      openAttachment(a.url, a.fileName).catch((e) => toast.error(String(e)));
                    }}
                  >
                    {a.fileName}
                  </button>
                  <span className="shrink-0 text-muted-foreground">{Math.round(a.bytes / 1024)} KB</span>
                  {task.description.includes(a.id) && (
                    <span className="shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground">
                      in description
                    </span>
                  )}
                  <button
                    className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    title={t("work:task.removeAttachment")}
                    onClick={() => void quitar(a)}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Where this came from, when it came from a client.
            Everything here has always been in the response — an item is one row
            and the task API returns all of it — but the board never read it, so
            a ticket opened from here showed no reporter and no clue what they
            were looking at when it broke. Rendered only when there is a channel:
            an internal card has none of it and would show a block of blanks. */}
        {task.projectId && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("work:task.reported")}
            </h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {(task.reporterName || task.reporterEmail) && (
                <>
                  <dt className="text-muted-foreground">{t("work:task.by")}</dt>
                  <dd className="break-words">
                    {task.reporterName || task.reporterEmail}
                    {task.reporterName && task.reporterEmail && (
                      <span className="text-muted-foreground"> · {task.reporterEmail}</span>
                    )}
                  </dd>
                </>
              )}
              {task.url && (
                <>
                  <dt className="text-muted-foreground">{t("work:task.on")}</dt>
                  <dd className="break-all">
                    {/* Their page, not ours: opened outside rather than routed
                        into the app, which would only 404. */}
                    <a
                      href={task.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-foreground"
                    >
                      {task.url}
                    </a>
                  </dd>
                </>
              )}
              {task.userAgent && (
                <>
                  <dt className="text-muted-foreground">{t("work:task.using")}</dt>
                  <dd className="break-words" title={task.userAgent}>
                    {describeAgent(task.userAgent)}
                    {task.viewport && (
                      <span className="text-muted-foreground"> · {task.viewport}</span>
                    )}
                  </dd>
                </>
              )}
              {task.category && (
                <>
                  <dt className="text-muted-foreground">{t("work:task.kind")}</dt>
                  <dd>
                    {task.category}
                    {task.area && <span className="text-muted-foreground"> · {task.area}</span>}
                    {task.origin === "system" && (
                      <span className="text-muted-foreground"> · {t("work:task.filedAutomatically")}</span>
                    )}
                  </dd>
                </>
              )}
            </dl>
          </section>
        )}

        {/* What led up to it. Absent when the report carried none or its TTL has
            passed and it was purged — both are normal, so there is no empty
            state to show. */}
        {detail.telemetry && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("work:task.beforeItBroke")}
            </h3>
            <TelemetryTimeline data={detail.telemetry} />
          </section>
        )}

        {/* Subtasks — a breakdown of this task, sharing the list's columns.
            They stay out of the board's columns so the work isn't counted twice. */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("work:task.subtasks")}{" "}
              {detail.subtasks.length > 0 && (
                <span className="normal-case">
                  ({detail.subtasks.filter((t) => doneStatusIds.has(t.statusId)).length}/
                  {detail.subtasks.length})
                </span>
              )}
            </h3>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={async () => {
                const titulo = await prompt({
                  title: t("work:task.newSubtaskTitle"),
                  label: t("work:task.newSubtaskLabel"),
                  confirmText: t("work:task.create"),
                });
                if (titulo) createSubtask(task.id, titulo).catch((e) => toast.error(String(e)));
              }}
            >
              {t("work:task.addSubtask")}
            </Button>
          </div>
          {detail.subtasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("work:task.noSubtasks")}
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {detail.subtasks.map((st) => {
                const done = doneStatusIds.has(st.statusId);
                return (
                  <div key={st.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                    <button
                      title={done ? t("work:task.reopen") : t("work:task.markComplete")}
                      onClick={() => {
                        // Toggle against the list's own columns, so this works
                        // whatever the user named them.
                        const target = done ? firstOpenStatusId : firstDoneStatusId;
                        if (!target) {
                          toast.error(t("work:task.noColumnForThat"));
                          return;
                        }
                        moveTask(st.id, target, "", "").catch((e) => toast.error(String(e)));
                      }}
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border",
                        done && "border-success bg-success/20",
                      )}
                    >
                      {done && <Check className="size-3 text-success" />}
                    </button>
                    <button
                      className={cn("min-w-0 flex-1 truncate text-left", done && "text-muted-foreground line-through")}
                      onClick={() => openTask(st.id)}
                    >
                      {st.title}
                    </button>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">#{st.seq}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Comments */}
        <section className="space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Activity ({detail.comments.length})
          </h3>
          {detail.comments.map((c) => (
            <CommentItem key={c.id} comment={c} taskId={task.id} onUpload={upload} clientReads={clientReads} />
          ))}

          <div className="space-y-2">
            {sinDestinatario && (
              <p className="flex items-start gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning-foreground">
                <Info className="mt-px size-3.5 shrink-0" />
                <span>{t("common:crash.noReporter")}</span>
              </p>
            )}
            <MarkdownEditor
              value={comment}
              onChange={setComment}
              onUpload={upload}
              // `@` only where the client cannot read it.
              //
              // Naming a colleague in something a client reads puts a teammate's
              // name in front of somebody it was never meant for, and the person
              // typing has no reason to notice — the picker looks the same
              // either way. So on a client-visible thread the extension simply
              // isn't loaded, and `@` stays an ordinary character.
              people={mentionsAllowed(clientReads, commentInternal) ? people : undefined}
              placeholder={
                mentionsAllowed(clientReads, commentInternal)
                  ? t("work:task.writeComment")
                  : t("work:task.writeCommentClient")
              }
              minHeight="5rem"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={send} disabled={sending || !comment.trim()}>
                {sending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
                <span className="ml-1">{clientReads && commentInternal ? t("work:task.commentInternally") : t("work:task.comment")}</span>
              </Button>
              {clientReads && (
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-1 rounded px-2 py-1 text-xs",
                    commentInternal
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setCommentInternal((v) => !v)}
                  title={
                    commentInternal
                      ? t("work:task.onlyTeamWillSee")
                      : t("work:task.clientReadsSwitch")
                  }
                >
                  {commentInternal ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                  {commentInternal ? t("work:task.internalNote") : t("work:task.theClientReads")}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Properties, in a rail of their own.

          Below the reading column on a narrow window rather than squeezed
          beside it: at that width neither half gets enough room to be read,
          and the description is the half that suffers. */}
      <aside className="w-full shrink-0 overflow-auto border-t p-4 lg:w-72 lg:border-l lg:border-t-0">
        {/* Stacked, not two columns. The grid was written for a 672px drawer;
            in a 288px rail a 7rem label leaves the controls too little and they
            push a horizontal scrollbar into a panel nobody scrolls sideways. */}
        <div className="space-y-3 text-sm [&>*]:min-w-0">
          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5" /> {t("work:task.status")}
          </span>
          <div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button className="rounded px-2 py-0.5 text-xs font-medium" style={{
                    backgroundColor: `${detail.status.color}22`,
                    color: detail.status.color,
                  }}>
                    {detail.status.name}
                  </button>
                }
              />
              <DropdownMenuContent align="start">
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {t("work:task.moveToColumn")}
                  </DropdownMenuLabel>
                  {/* Sin columnas hay algo roto, y decirlo aquí es lo único
                      que separa «no se puede mover» de «el menú está vacío». */}
                  {columnas.length === 0 && (
                    <DropdownMenuItem disabled className="text-destructive">
                      {fallo ?? t("work:task.loadingColumns")}
                    </DropdownMenuItem>
                  )}
                  {columnas.map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      onClick={() => {
                        if (s.id === task.statusId) return;
                        // Appending (no neighbours) is the least surprising drop
                        // point when moving from the detail view.
                        moveTask(task.id, s.id, "", "").catch((e) => toast.error(String(e)));
                      }}
                    >
                      <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
                      {s.name}
                      {s.id === task.statusId && <Check className="ml-auto size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Flag className="size-3.5" /> Priority
          </span>
          <div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button className={cn("text-xs", priorityMeta(task.priority).className)}>
                    {priorityMeta(task.priority).label}
                  </button>
                }
              />
              <DropdownMenuContent align="start">
                <DropdownMenuGroup>
                  {PRIORITIES.map((p) => (
                    <DropdownMenuItem
                      key={p}
                      onClick={() => updateTask(task.id, { priority: p }).catch((e) => toast.error(String(e)))}
                    >
                      <Flag className={cn("size-3.5", priorityMeta(p).className)} />
                      {priorityMeta(p).label}
                      {p === task.priority && <Check className="ml-auto size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <TagIcon className="size-3.5" /> Tags
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {detail.tags.map((t) => (
              <span
                key={t.id}
                className="rounded px-1.5 py-0.5 text-xs"
                style={{ backgroundColor: `${t.color || "#8B5CF6"}22`, color: t.color || undefined }}
              >
                {t.name}
              </span>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button className="rounded border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                    + tag
                  </button>
                }
              />
              <DropdownMenuContent align="start">
                <DropdownMenuGroup>
                  {orgTags.map((t) => (
                    <DropdownMenuItem
                      key={t.id}
                      onClick={() => {
                        const next = tagIds.has(t.id)
                          ? detail.tags.filter((x) => x.id !== t.id).map((x) => x.id)
                          : [...detail.tags.map((x) => x.id), t.id];
                        updateTask(task.id, { tagIds: next }).catch((e) => toast.error(String(e)));
                      }}
                    >
                      <span className="size-2 rounded-full" style={{ backgroundColor: t.color || "#8B5CF6" }} />
                      {t.name}
                      {tagIds.has(t.id) && <Check className="ml-auto size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem
                    onClick={async () => {
                      const name = await prompt({
                        title: t("work:task.newTagTitle"),
                        label: t("work:task.newTagLabel"),
                        confirmText: t("work:task.create"),
                      });
                      if (!name) return;
                      const created = await createTag(task.orgId, name, "#8B5CF6");
                      if (created) {
                        updateTask(task.id, {
                          tagIds: [...detail.tags.map((x) => x.id), created.id],
                        }).catch((e) => toast.error(String(e)));
                      }
                    }}
                  >
                    {t("work:task.newTag")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5" /> {t("work:task.assignees")}
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {detail.assignees.map((a) => (
              <Badge key={a.id} variant="secondary" className="gap-1 text-xs">
                {a.username}
                <button
                  onClick={() =>
                    updateTask(task.id, {
                      assigneeIds: detail.assignees.filter((x) => x.id !== a.id).map((x) => x.id),
                    }).catch((e) => toast.error(String(e)))
                  }
                  aria-label={t("work:task.removeAssignee", { name: a.username })}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <div className="w-44">
              <UserPicker
                scope="org"
                placeholder={t("work:task.assign")}
                onSelect={(u) => {
                  if (detail.assignees.some((a) => a.id === u.id)) return;
                  updateTask(task.id, {
                    assigneeIds: [...detail.assignees.map((a) => a.id), u.id],
                  }).catch((e) => toast.error(String(e)));
                }}
              />
            </div>
          </div>

          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Calendar className="size-3.5" /> {t("work:task.due")}
          </span>
          <div>
            <input
              type="date"
              value={task.dueAt ? task.dueAt.slice(0, 10) : ""}
              onChange={(e) =>
                updateTask(task.id, {
                  dueAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                }).catch((err) => toast.error(String(err)))
              }
              className="rounded border bg-transparent px-2 py-0.5 text-xs"
            />
          </div>
        </div>

      </aside>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={async () => {
            const ok = await confirm({
              title: t("work:task.deleteTaskTitle", { name: task.title }),
              description: t("work:task.deleteTaskBody"),
              confirmText: t("work:task.delete"),
              destructive: true,
            });
            if (ok) deleteTask(task.id).catch((e) => toast.error(String(e)));
          }}
        >
          <Trash2 className="size-3 mr-1" /> {t("work:task.deleteTask")}
        </Button>
        {task.projectId && task.visibility !== "internal" && (
          <Button
            size="sm"
            variant="ghost"
            className="text-xs"
            onClick={async () => {
              const ok = await confirm({
                title: t("work:task.withdrawTitle"),
                description: t("work:task.withdrawBody"),
                confirmText: t("work:task.withdraw"),
              });
              if (!ok) return;
              updateTask(task.id, { visibility: "internal" }).catch((e) => toast.error(String(e)));
            }}
          >
            <EyeOff className="size-3 mr-1" /> {t("work:task.withdraw")}
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("work:task.updated", { when: fechaYHora(task.updatedAt) })}
        </span>
      </footer>
    </>
  );
}

/**
 * Lo que se ve cuando algo no carga.
 *
 * Antes: «Could not load this task.» y un botón de cerrar. Ni el motivo, ni el
 * id, ni rastro en ninguna parte — un callejón que no se puede buscar ni
 * reportar, y que tapó una semana entera de reportes de cliente que no
 * aterrizaban en ningún tablero.
 *
 * Ahora dice qué contestó el servidor y levanta la tarjeta en cac por su
 * cuenta, con la misma firma que ya deduplica los pantallazos. La firma sale
 * del **motivo** y no del id: si mañana fallan cuarenta reportes por lo mismo,
 * es un problema, no cuarenta.
 */
function CouldNotOpen({
  id,
  reason,
  onClose,
}: {
  id: string;
  reason: string | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [filed, setFichado] = useState<Fichado>("no");
  const yaFichado = useRef<string | null>(null);

  useEffect(() => {
    if (!reason || yaFichado.current === reason) return;
    yaFichado.current = reason;
    void (async () => {
      setFichado("filing");
      setFichado(
        await fileCrash({
          title: `No abre una tarjeta: ${reason}`,
          description: [
            `**El detalle de un item no cargó.**`,
            "",
            `Motivo del servidor: \`${reason}\``,
            `Item: \`${id}\``,
            `Ruta: \`${rutaActual()}\``,
          ].join("\n"),
          key: signature(`detail-failed: ${reason}`),
        }),
      );
    })();
  }, [reason, id]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm">{t("common:crash.cardFailed")}</p>
      {reason && (
        <pre className="max-w-lg overflow-auto rounded border bg-muted/40 px-2 py-1 text-xs">
          {reason}
        </pre>
      )}
      <p className="text-xs text-muted-foreground">
        {filed === "done"
          ? t("common:crash.filed")
          : filed === "failed"
            ? t("common:crash.failed")
            : filed === "filing"
              ? t("common:crash.filing")
              : t("common:crash.noSession")}
      </p>
      <Button size="sm" variant="outline" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
