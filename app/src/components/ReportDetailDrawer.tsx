import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, Loader2, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiUrl } from "@/lib/api";
import Markdown from "@/components/markdown/Markdown";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import { useReportsStore } from "@/store/reports.store";
import { useAuthStore } from "@/store/auth.store";
import { useConfirm } from "@/components/ConfirmDialog";
import { Input } from "@/components/ui/input";
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type ReportComment,
  type ReportStatus,
} from "@/types/report";
import TelemetryTimeline from "@/components/TelemetryTimeline";

/** A compact dropdown over one of the server-published sets. */
function TaxonomySelect<T extends string>({
  value,
  options,
  labels,
  onChange,
}: {
  value: T;
  options: T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
}) {
  if (options.length === 0) return null;
  return (
    <Select
      items={labels}
      value={value}
      onValueChange={(v) => v && v !== value && onChange(v as T)}
    >
      <SelectTrigger size="sm" className="h-7 min-w-28 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {labels[o]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Who to show as having written a comment.
 *
 * A tenant's reply always names the tenant next to the person, and that is the
 * point rather than decoration: the person's name is asserted by the tenant and
 * verified by nobody, so one sending `authorName: "admin"` must not read like
 * the cac user of the same name.
 *
 * Falls back to the flat fields for a server that predates `author`; the two
 * ship separately and this app is installed, not served.
 */
function commentByline(c: ReportComment): string {
  const a = c.author;
  if (!a) return c.authorName || c.authorLabel || "reporter";
  switch (a.kind) {
    case "user":
      return a.name || "unknown";
    case "tenant":
      return a.name && a.name !== a.projectName
        ? `${a.name} · ${a.projectName}`
        : a.projectName || "tenant";
    default:
      // The report knows who filed it, so use the name rather than the role.
      return a.name || "reporter";
  }
}

/** One reply in the thread, with the author's own edit and delete. */
function CommentRow({ c }: { c: ReportComment }) {
  const session = useAuthStore((s) => s.session);
  const editComment = useReportsStore((s) => s.editComment);
  const deleteComment = useReportsStore((s) => s.deleteComment);
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const [saving, setSaving] = useState(false);
  // Staged while editing: nothing leaves the client until Save, so the edit
  // lands as one operation on the server too.
  const [dropped, setDropped] = useState<string[]>([]);
  const [added, setAdded] = useState<File[]>([]);
  const pickFile = useRef<HTMLInputElement>(null);

  const withdrawn = !!c.deletedAt;
  const keptImages = (c.images ?? []).filter((i) => !dropped.includes(i.id));

  // Author only — no superadmin override, unlike tasks. The server refuses
  // anyone else outright, so the button would 403; and this thread is read by
  // the person who filed the report, where rewriting someone else's reply
  // changes what a customer sees attributed to them.
  const mine = !!session?.id && session.id === c.author?.userId;
  const edited =
    new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000;

  const startEdit = () => {
    setDraft(c.body);
    setDropped([]);
    setAdded([]);
    setEditing(true);
  };

  const save = async () => {
    const body = draft.trim();
    // The server refuses a comment left with neither, so don't send it.
    if (!body && keptImages.length + added.length === 0) return;
    setSaving(true);
    try {
      await editComment(c.id, { body, add: added, removeImageIds: dropped });
      setEditing(false);
    } catch (e) {
      toast.error("Could not save the comment", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={
        "group rounded-md border p-3 space-y-2" +
        // Withdrawn comments only reach cac; the tenant and the reporter never
        // receive them. Dimmed rather than hidden so the team keeps the record.
        (withdrawn ? " border-dashed opacity-60" : "")
      }
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{commentByline(c)}</span>
        {withdrawn && <span className="italic">withdrawn · only visible here</span>}
        {edited && !withdrawn && <span className="italic">edited</span>}
        <span className="ml-auto">{new Date(c.createdAt).toLocaleString()}</span>
        {mine && !editing && !withdrawn && (
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              className="hover:text-foreground"
              title="Edit comment"
              onClick={startEdit}
            >
              <Pencil className="size-3" />
            </button>
            <button
              className="hover:text-destructive"
              title="Delete comment"
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete this comment?",
                  description:
                    "It disappears from the thread for everyone, including the person who filed the report.",
                  confirmText: "Delete",
                  destructive: true,
                });
                if (!ok) return;
                deleteComment(c.id).catch((e) =>
                  toast.error("Could not delete the comment", {
                    description: e instanceof Error ? e.message : String(e),
                  })
                );
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
            onFiles={(fs) => setAdded((prev) => [...prev, ...fs])}
            minHeight="4rem"
            autoFocus
          />
          {/* Existing attachments, each removable. Staged: the image stays on
              the server until Save, so cancelling really cancels. */}
          {(keptImages.length > 0 || added.length > 0) && (
            <div className="grid grid-cols-3 gap-2">
              {keptImages.map((img) => (
                <div key={img.id} className="relative">
                  <ZoomImg
                    src={apiUrl(img.url)}
                    alt={img.fileName}
                    className="rounded border object-cover aspect-square w-full"
                  />
                  <button
                    className="absolute right-1 top-1 rounded bg-background/90 p-0.5 text-destructive"
                    title="Remove this image"
                    onClick={() => setDropped((d) => [...d, img.id])}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
              {added.map((f, i) => (
                <StagedFile
                  key={`${f.name}-${f.size}-${i}`}
                  file={f}
                  onRemove={() => setAdded((a) => a.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}
          <input
            ref={pickFile}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              setAdded((a) => [...a, ...Array.from(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={save}
              disabled={saving || (!draft.trim() && keptImages.length + added.length === 0)}
            >
              {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => pickFile.current?.click()}>
              <Paperclip className="mr-1 size-3" /> Add image
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {c.body && <Markdown>{c.body}</Markdown>}
          {c.images && c.images.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {c.images.map((img) => (
                <ZoomImg
                  key={img.id}
                  src={apiUrl(img.url)}
                  alt={img.fileName}
                  className="rounded border object-cover aspect-square w-full"
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ReportDetailDrawer() {
  const selectedId = useReportsStore((s) => s.selectedId);
  const detail = useReportsStore((s) => s.detail);
  const loading = useReportsStore((s) => s.detailLoading);
  const transitions = useReportsStore((s) => s.transitions);
  const closeReport = useReportsStore((s) => s.closeReport);
  const changeDetailStatus = useReportsStore((s) => s.changeDetailStatus);
  const changeDetailTaxonomy = useReportsStore((s) => s.changeDetailTaxonomy);
  const taxonomy = useReportsStore((s) => s.taxonomy);
  const addComment = useReportsStore((s) => s.addComment);
  const fetchTransitions = useReportsStore((s) => s.fetchTransitions);

  useEffect(() => {
    fetchTransitions();
  }, [fetchTransitions]);

  const statusOptions: ReportStatus[] = detail
    ? [detail.status, ...(transitions?.[detail.status] ?? [])]
    : [];

  return (
    <Sheet open={!!selectedId} onOpenChange={(o) => !o && closeReport()}>
      <SheetContent className="w-full sm:max-w-xl flex flex-col gap-0 p-0">
        {loading && (
          <div className="flex-1 grid place-items-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {detail && (
          <>
            <SheetHeader className="border-b px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {detail.folio}
                </span>
                {detail.origin === "system" && (
                  <Badge variant="outline" className="text-[10px] py-0">system</Badge>
                )}
              </div>
              <SheetTitle className="text-base leading-snug">{detail.title}</SheetTitle>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* status */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-muted-foreground">Status</label>
                <Select
                  items={STATUS_LABELS}
                  value={detail.status}
                  onValueChange={async (v) => {
                    if (!v) return;
                    try {
                      await changeDetailStatus(v as ReportStatus);
                    } catch (err) {
                      toast.error("Transition failed", {
                        description: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                >
                  <SelectTrigger size="sm" className="min-w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Triage labels. Editable inline: they carry no state machine, so
                  there is nothing to confirm and no illegal move to guard against. */}
              <div className="flex flex-wrap items-center gap-2">
                <TaxonomySelect
                  value={detail.category}
                  options={taxonomy?.categories ?? []}
                  labels={CATEGORY_LABELS}
                  onChange={(category) => changeDetailTaxonomy({ category })}
                />
                <TaxonomySelect
                  value={detail.priority}
                  options={taxonomy?.priorities ?? []}
                  labels={PRIORITY_LABELS}
                  onChange={(priority) => changeDetailTaxonomy({ priority })}
                />
                <Input
                  defaultValue={detail.area}
                  placeholder="Area"
                  className="h-7 w-40 text-xs"
                  // Committed on blur, not per keystroke: this is free text and
                  // every character would otherwise be a PATCH.
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next !== detail.area) changeDetailTaxonomy({ area: next });
                  }}
                />
              </div>

              {detail.description && (
                <Markdown>{detail.description}</Markdown>
              )}

              {/* metadata */}
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-xs">
                <Meta label="Project" value={detail.projectSlug} />
                {detail.url && (
                  <>
                    <dt className="text-muted-foreground">URL</dt>
                    <dd className="truncate">
                      <a
                        href={detail.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {detail.url}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </dd>
                  </>
                )}
                <Meta label="Viewport" value={detail.viewport} />
                <Meta
                  label="Reporter"
                  value={detail.reporterName || detail.reporterEmail || detail.reporterId}
                />
                <Meta label="Reporter ID" value={detail.reporterId} />
                <Meta label="User agent" value={detail.userAgent} />
              </dl>

              {/* gallery */}
              {detail.images.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {detail.images.map((img) => (
                    <ZoomImg
                      key={img.id}
                      src={apiUrl(img.url)}
                      alt={img.fileName}
                      className="rounded-md border object-cover aspect-square w-full"
                    />
                  ))}
                </div>
              )}

              {/* telemetry timeline (decision 7) */}
              {detail.telemetry && <TelemetryTimeline data={detail.telemetry} />}

              {/* comments */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Activity</h3>
                {detail.comments.map((c) =>
                  c.kind === "system" ? (
                    <p key={c.id} className="text-xs text-muted-foreground italic">
                      {c.body}
                    </p>
                  ) : (
                    <CommentRow key={c.id} c={c} />
                  )
                )}
              </div>
            </div>

            <CommentComposer onSend={addComment} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** Thumbnail that opens a full-screen lightbox on click. svh/svw avoids the
 * mobile browser-chrome jump. */
function ZoomImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onClick={() => setOpen(true)}
        className={`cursor-zoom-in ${className ?? ""}`}
      />
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[9999] grid cursor-zoom-out place-items-center bg-black/85 p-6"
        >
          <img src={src} alt={alt} className="max-h-[95svh] max-w-[95svw] rounded-md object-contain" />
        </div>
      )}
    </>
  );
}

/**
 * One file that's been staged but not sent yet.
 *
 * These used to be name-only chips, which said nothing: every image the
 * clipboard hands over arrives called `pasted.png`, so two screenshots looked
 * identical and there was no way to tell which one to take back out — or to
 * check you'd pasted the right thing at all.
 */
function StagedFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);

  // Created inside the effect, not beside it. Object URLs pin the bitmap in
  // memory until released — a drawer left open across a dozen pastes would
  // hold every one — but releasing a URL built outside the effect breaks under
  // StrictMode: React mounts, unmounts and remounts, the cleanup revokes the
  // URL, and nothing creates a replacement. The thumbnail survives on the
  // already-decoded bitmap while the zoom, a fresh <img>, loads nothing.
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [file]);

  return (
    <div className="relative w-16">
      {url ? (
        <ZoomImg
          src={url}
          alt={file.name}
          className="aspect-square w-full rounded border object-cover"
        />
      ) : (
        <div
          title={file.name}
          className="grid aspect-square w-full place-items-center rounded border border-dashed p-1 text-center text-[10px] text-muted-foreground"
        >
          <span className="truncate">{file.name}</span>
        </div>
      )}
      <button
        type="button"
        title={`Remove ${file.name}`}
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 rounded bg-background/90 p-0.5 text-destructive hover:bg-background"
      >
        <Trash2 className="size-3" />
      </button>
    </div>
  );
}

function Meta({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </>
  );
}

function CommentComposer({
  onSend,
}: {
  onSend: (body: string, files: File[]) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async () => {
    if (!body.trim() && files.length === 0) return;
    setSending(true);
    try {
      await onSend(body.trim(), files);
      setBody("");
      setFiles([]);
    } catch (e) {
      toast.error("Failed to send", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t p-3 space-y-2">
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <StagedFile
              key={`${f.name}-${f.size}-${i}`}
              file={f}
              onRemove={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {/* A contenteditable, not a textarea, and that is the whole reason.
            WebKit hands the clipboard to a target that can hold it: paste a
            screenshot into a <textarea> and the event arrives with types: [],
            items: [], files: 0 — nothing to read, however the handler is
            written. The same paste into this editor works, which is why it
            always worked in tasks and never here.

            onFiles instead of onUpload: the files are staged and sent with the
            comment, so the images stay rows with signed URLs the reporter can
            open. Uploading and embedding a link would bake in a URL that
            expires. */}
        <div className="flex-1">
          <MarkdownEditor
            value={body}
            onChange={setBody}
            onFiles={(fs) => setFiles((prev) => [...prev, ...fs])}
            placeholder="Add a comment… (paste or drop a screenshot)"
            minHeight="3.5rem"
          />
        </div>
        <div className="flex flex-col gap-1">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            // Append, like pasting does — picking a second file used to throw
            // away whatever was already staged.
            onChange={(e) => {
              setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Button size="icon" variant="outline" onClick={() => fileRef.current?.click()}>
            <Paperclip className="h-4 w-4" />
          </Button>
          <Button size="icon" onClick={send} disabled={sending}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
