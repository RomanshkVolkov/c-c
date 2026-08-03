import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, Loader2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiUrl } from "@/lib/api";
import Markdown from "@/components/markdown/Markdown";
import { useReportsStore } from "@/store/reports.store";
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
      return "reporter";
  }
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
                    <div key={c.id} className="rounded-md border p-3 space-y-2">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{commentByline(c)}</span>
                        <span>{new Date(c.createdAt).toLocaleString()}</span>
                      </div>
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
                    </div>
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

function Meta({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </>
  );
}

/**
 * Extract pasted image files from a clipboard event. WebKitGTK (the Tauri
 * webview on Linux) exposes pasted screenshots via clipboardData.items
 * (getAsFile), leaving .files empty — so we read items first, then fall back to
 * .files (drag/other browsers). Deduped by name+size.
 */
function imagesFromClipboard(e: React.ClipboardEvent): File[] {
  const dt = e.clipboardData;
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith("image/") && !out.some((o) => o.name === f.name && o.size === f.size)) {
      out.push(f);
    }
  }
  return out;
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
        <div className="flex flex-wrap gap-1">
          {files.map((f, i) => (
            <Badge key={i} variant="secondary" className="text-[10px]">
              {f.name}
            </Badge>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment… (Enter to send, Shift+Enter for newline)"
          rows={2}
          className="resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          onPaste={(e) => {
            const imgs = imagesFromClipboard(e);
            if (imgs.length) {
              e.preventDefault(); // don't dump the image as junk text into the field
              setFiles((prev) => [...prev, ...imgs]);
            }
          }}
        />
        <div className="flex flex-col gap-1">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
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
