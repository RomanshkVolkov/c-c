import { useEffect, useState } from "react";
import { FileText, Loader2, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import Markdown from "@/components/markdown/Markdown";
import { openAttachment } from "@/lib/media";
import CopyId from "@/components/CopyId";
import { useTasksStore } from "@/store/tasks.store";

const KIND_LABEL: Record<string, string> = {
  space: "Space",
  folder: "Folder",
  list: "List",
};

/**
 * The overview of one node: a single markdown document describing a space, a
 * folder or a list.
 *
 * One document per node rather than a page tree — it needs no navigation of its
 * own, and it's the place documentation actually belongs when folders already
 * map to modules. Editing is explicit (Edit → Save) for the same reason task
 * descriptions are: this is a rich editor, and autosaving every keystroke would
 * fight the live refresh.
 */
export default function DocView() {
  const target = useTasksStore((s) => s.activeDoc);
  const doc = useTasksStore((s) => s.doc);
  const loading = useTasksStore((s) => s.loadingDoc);
  const saveDoc = useTasksStore((s) => s.saveDoc);
  const upload = useTasksStore((s) => s.uploadDocAttachment);
  const closeDoc = useTasksStore((s) => s.closeDoc);

  const body = doc?.doc?.body ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [saving, setSaving] = useState(false);

  // Switching nodes must not carry a half-written draft over to another doc.
  useEffect(() => {
    setEditing(false);
  }, [target?.kind, target?.id]);

  // Adopt the stored body — but never on top of something being written.
  //
  // `body` has to stay a dependency here, unlike the task drawer's equivalent:
  // this pane renders before its document has loaded, so the first value is
  // always "" and the real one arrives later. Dropping the dependency would
  // open the editor empty on a document that has content. The `editing` guard
  // is what makes that safe.
  useEffect(() => {
    if (editing) return;
    setDraft(body);
  }, [body, editing]);

  if (!target) return null;

  const save = async () => {
    setSaving(true);
    try {
      await saveDoc(draft);
      setEditing(false);
    } catch (e) {
      toast.error("Could not save the overview", { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-sm font-medium">{target.name}</h1>
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
          {KIND_LABEL[target.kind] ?? target.kind} overview
        </span>
        <CopyId id={target.id} label={target.kind} />

        {doc?.doc?.updatedByName && !editing && (
          <span className="hidden text-xs text-muted-foreground sm:inline">
            edited by {doc.doc.updatedByName}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {!editing && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(true)}>
              <Pencil className="mr-1 size-3" />
              {body ? "Edit" : "Write one"}
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" title="Close" onClick={closeDoc}>
            <X className="size-3.5" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto w-full max-w-3xl">
          {loading && !doc ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          ) : editing ? (
            <div className="space-y-2">
              <MarkdownEditor
                value={draft}
                onChange={setDraft}
                onUpload={upload}
                collapsible
                blockTools
                minHeight="24rem"
                placeholder="What is this for? Links, decisions, how to run it…"
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={save} disabled={saving}>
                  {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(body);
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : body ? (
            // Written by the team, unlike a report's description — so the
            // sanitized <details>/<summary> subset is safe to render here.
            <Markdown allowHtml>{body}</Markdown>
          ) : (
            <div className="py-16 text-center">
              <p className="text-sm text-muted-foreground">
                No overview yet. Describe what lives here — links, decisions, how to run it.
              </p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setEditing(true)}>
                <Pencil className="mr-1 size-3" /> Write one
              </Button>
            </div>
          )}

          {!editing && doc && doc.attachments.length > 0 && (
            <section className="mt-8 space-y-2 border-t pt-4">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Files
              </h2>
              <ul className="space-y-1">
                {doc.attachments.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-xs">
                    <button
                      className="truncate text-left text-primary underline"
                      onClick={() => openAttachment(a.url, a.fileName).catch((e) => toast.error(String(e)))}
                    >
                      {a.fileName}
                    </button>
                    <span className="text-muted-foreground">{Math.round(a.bytes / 1024)} KB</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
