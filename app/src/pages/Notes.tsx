import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
  ArrowUp,
  ArrowDown,
  AlertCircle,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import MarkdownEditor, { type MarkdownEditorHandle } from "@/components/markdown/MarkdownEditor";
import { useConfirm } from "@/components/ConfirmDialog";
import { usePrompt } from "@/components/PromptDialog";
import { useNotesStore } from "@/store/notes.store";
import type { NoteTreeItem } from "@/types/note";
import { cn } from "@/lib/utils";

/**
 * Personal notes: a nested page tree, private to the signed-in user.
 *
 * Deliberately its own module, not an extension of the task board's Overview —
 * that one is one document per space/folder/list and org-scoped; this is many
 * pages, arbitrarily nested, and never visible to anyone but the owner (not
 * even a superadmin — see the backend's RawAttachment comment for why that's
 * an intentional exception to how every other module in cac works).
 *
 * The tree is read from a persisted copy first (see notes.store's `persist`),
 * so it — and whichever note was last open — stay readable with no network.
 * Editing the open page works offline too: a body save that can't reach the
 * server is queued (persisted, so it survives closing the app) and retried
 * here. Creating, moving and deleting still need a live connection.
 */
export default function Notes() {
  const navigate = useNavigate();
  const { id } = useParams();
  const fetchTree = useNotesStore((s) => s.fetchTree);
  const openNote = useNotesStore((s) => s.openNote);
  const closeNote = useNotesStore((s) => s.closeNote);
  const activeId = useNotesStore((s) => s.activeId);
  const drainPending = useNotesStore((s) => s.drainPending);
  const conflictNotice = useNotesStore((s) => s.conflictNotice);
  const dismissConflict = useNotesStore((s) => s.dismissConflict);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    fetchTree();
  }, [fetchTree]);

  // The URL is the source of truth for which note is open, so a link (or the
  // back button) works the way every other route in the app does.
  useEffect(() => {
    if (id && id !== activeId) openNote(id);
    else if (!id && activeId) closeNote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Retries queued writes as soon as the network's back, and every few
  // seconds regardless — an empty queue makes this a no-op, so there's no cost
  // to leaving the interval running while there's nothing to send.
  useEffect(() => {
    drainPending();
    window.addEventListener("online", drainPending);
    const t = setInterval(drainPending, 10_000);
    return () => {
      window.removeEventListener("online", drainPending);
      clearInterval(t);
    };
  }, [drainPending]);

  useEffect(() => {
    if (!conflictNotice) return;
    toast.warning("Saved as a conflict copy", {
      description: `Another device changed this page first — your edit is safe in "${conflictNotice.conflictTitle}".`,
      action: {
        label: "Open",
        onClick: () => navigate(`/notes/${conflictNotice.conflictId}`),
      },
    });
    dismissConflict();
  }, [conflictNotice, dismissConflict, navigate]);

  return (
    <div className="flex min-h-0 flex-1">
      <Navigator onSearch={() => setSearchOpen(true)} />
      {activeId ? <NoteEditorPane id={activeId} /> : <EmptyState />}
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} onPick={(nid) => navigate(`/notes/${nid}`)} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <FileText className="mx-auto size-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm text-muted-foreground">
          Pick a page, or create one to start writing.
        </p>
      </div>
    </div>
  );
}

// ─── Navigator ──────────────────────────────────────────────────────────────

function Navigator({ onSearch }: { onSearch: () => void }) {
  const navigate = useNavigate();
  const tree = useNotesStore((s) => s.tree);
  const loading = useNotesStore((s) => s.loadingTree);
  const error = useNotesStore((s) => s.error);
  const createNote = useNotesStore((s) => s.createNote);

  const roots = useMemo(
    () => tree.filter((n) => !n.parentId).sort((a, b) => a.position - b.position),
    [tree],
  );

  const addRoot = async () => {
    const n = await createNote(null);
    if (n) navigate(`/notes/${n.id}`);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/10">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <span className="text-sm font-medium">Notes</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" title="Search (⌘P)" onClick={onSearch}>
          <Search className="size-3.5" />
        </Button>
        <Button size="icon-xs" variant="ghost" title="New page" onClick={addRoot}>
          <Plus className="size-3.5" />
        </Button>
      </header>
      <div className="flex-1 overflow-auto py-1">
        {error && (
          <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="size-3" /> {error}
          </p>
        )}
        {loading && tree.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : roots.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            No pages yet. Create one to start writing.
          </p>
        ) : (
          roots.map((n) => <NoteRow key={n.id} note={n} depth={0} />)
        )}
      </div>
    </aside>
  );
}

function NoteRow({ note, depth }: { note: NoteTreeItem; depth: number }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const tree = useNotesStore((s) => s.tree);
  const activeId = useNotesStore((s) => s.activeId);
  const createNote = useNotesStore((s) => s.createNote);
  const renameNote = useNotesStore((s) => s.renameNote);
  const deleteNote = useNotesStore((s) => s.deleteNote);
  const descendantsOf = useNotesStore((s) => s.descendantsOf);
  const moveTree = useNotesStore((s) => s.moveTree);
  const [open, setOpen] = useState(true);

  const children = useMemo(
    () =>
      tree
        .filter((n) => n.parentId === note.id)
        .sort((a, b) => a.position - b.position),
    [tree, note.id],
  );

  const siblings = useMemo(
    () =>
      tree
        .filter((n) => (n.parentId ?? null) === (note.parentId ?? null))
        .sort((a, b) => a.position - b.position),
    [tree, note.parentId],
  );

  const move = (dir: "up" | "down") => {
    const idx = siblings.findIndex((n) => n.id === note.id);
    const swapWith = dir === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= siblings.length) return; // already at the edge
    const a = siblings[idx];
    const b = siblings[swapWith];
    moveTree([
      { id: a.id, parentId: a.parentId ?? null, position: b.position },
      { id: b.id, parentId: b.parentId ?? null, position: a.position },
    ]).catch((e) => toast.error(String(e)));
  };

  return (
    <div>
      <div
        className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn("text-muted-foreground", children.length === 0 && "invisible")}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button
          className={cn(
            "flex-1 truncate text-left text-sm hover:underline",
            activeId === note.id && "text-primary",
          )}
          onClick={() => navigate(`/notes/${note.id}`)}
        >
          {note.title || "Untitled"}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="text-muted-foreground opacity-0 group-hover:opacity-100" aria-label="Page menu">
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={async () => {
                  const n = await createNote(note.id);
                  if (n) navigate(`/notes/${n.id}`);
                }}
              >
                <Plus className="size-4" /> New subpage
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const t = await prompt({ title: "Rename page", label: "Title", defaultValue: note.title });
                  if (t) renameNote(note.id, t).catch((e) => toast.error(String(e)));
                }}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => move("up")}>
                <ArrowUp className="size-4" /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => move("down")}>
                <ArrowDown className="size-4" /> Move down
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  const count = descendantsOf(note.id).length - 1;
                  const ok = await confirm({
                    title: `Delete "${note.title || "Untitled"}"?`,
                    description:
                      count > 0
                        ? `This also deletes ${count} subpage${count > 1 ? "s" : ""}. This can't be undone.`
                        : "This can't be undone.",
                    confirmText: "Delete",
                    destructive: true,
                  });
                  if (!ok) return;
                  const wasActive = activeId === note.id || descendantsOf(note.id).includes(activeId ?? "");
                  deleteNote(note.id)
                    .then(() => {
                      if (wasActive) navigate("/notes");
                    })
                    .catch((e) => toast.error(String(e)));
                }}
              >
                <Trash2 className="size-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && children.map((c) => <NoteRow key={c.id} note={c} depth={depth + 1} />)}
    </div>
  );
}

// ─── Editor ─────────────────────────────────────────────────────────────────

const AUTOSAVE_DELAY_MS = 500;

function NoteEditorPane({ id }: { id: string }) {
  const navigate = useNavigate();
  const detail = useNotesStore((s) => s.detail);
  const loading = useNotesStore((s) => s.loadingDetail);
  const savedAt = useNotesStore((s) => s.savedAt);
  const saveBody = useNotesStore((s) => s.saveBody);
  const renameNote = useNotesStore((s) => s.renameNote);
  const upload = useNotesStore((s) => s.uploadAttachment);
  const createNote = useNotesStore((s) => s.createNote);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);

  const note = detail?.note;
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The unmount-flush effect below only re-subscribes when `id` changes (on
  // purpose — it must fire once per note, not reset on every keystroke), so its
  // closure over `body` would otherwise go stale the moment the user types
  // after the note first loads. A ref sidesteps that: it's always the latest
  // value, regardless of which render's closure reads it.
  const bodyRef = useRef(body);

  // A different note replaces the draft outright — no debounce should carry a
  // half-typed sentence from the page the user just left onto the new one.
  useEffect(() => {
    setTitle(note?.title ?? "");
    setBody(note?.body ?? "");
    bodyRef.current = note?.body ?? "";
  }, [note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleSave = (nextBody: string) => {
    setBody(nextBody);
    bodyRef.current = nextBody;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await saveBody(id, nextBody);
      } catch (e) {
        toast.error("Could not save", { description: String(e) });
      } finally {
        setSaving(false);
        // Without this, `timer.current` keeps pointing at an already-fired
        // timeout. The unmount-flush effect below only checks truthiness, so
        // it would then re-save on every later unmount — including with
        // whatever stale body happened to be in the ref at that point, even
        // though this save already completed and nothing is pending.
        timer.current = null;
      }
    }, AUTOSAVE_DELAY_MS);
  };

  useEffect(() => () => {
    // Flush a pending save instead of dropping the last few keystrokes when the
    // user navigates away before the debounce fires. Reads the ref, not the
    // `body` state — see the comment on bodyRef's declaration for why the
    // state variable can't be trusted here.
    if (timer.current) {
      clearTimeout(timer.current);
      saveBody(id, bodyRef.current).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Ctrl/Cmd+click on a link inside the editor — see MarkdownEditor's
  // onLinkClick doc: a plain click keeps editing the link's text.
  const openInternalLink = (href: string) => {
    const path = href.match(/^\/notes\/([^/?#]+)/)?.[1];
    if (path) navigate(`/notes/${path}`);
  };

  // Cmd/Ctrl+K opens the link picker, scoped to this pane so it doesn't
  // collide with the notes-list search shortcut (⌘P) or any other page's use
  // of the same combo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLinkPickerOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading && !note) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!note) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Could not load this page.
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title !== note.title) renameNote(id, title || "Untitled").catch((e) => toast.error(String(e)));
          }}
          placeholder="Untitled"
          className="h-8 border-none px-1 text-sm font-medium shadow-none focus-visible:ring-0"
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          {saving ? (
            <span className="flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" /> Saving…
            </span>
          ) : savedAt ? (
            <span className="flex items-center gap-1">
              <Check className="size-3" /> Saved
            </span>
          ) : null}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Link to a page (⌘K)"
          onClick={() => setLinkPickerOpen(true)}
        >
          <Link2 className="size-3.5" />
        </Button>
        <Button size="icon-xs" variant="ghost" title="Close" onClick={() => navigate("/notes")}>
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto w-full max-w-3xl">
          <MarkdownEditor
            ref={editorRef}
            value={body}
            onChange={scheduleSave}
            onUpload={upload}
            onLinkClick={openInternalLink}
            minHeight="24rem"
            placeholder="Write… (⌘K to link another page)"
          />
          {!loading && detail && detail.backlinks.length > 0 && (
            <section className="mt-8 space-y-2 border-t pt-4">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Linked from
              </h2>
              <ul className="space-y-1">
                {detail.backlinks.map((b) => (
                  <li key={b.id}>
                    <button
                      className="truncate text-left text-sm text-primary underline decoration-primary/40 hover:decoration-primary"
                      onClick={() => navigate(`/notes/${b.id}`)}
                    >
                      {b.title || "Untitled"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <NoteLinkPicker
        open={linkPickerOpen}
        onOpenChange={setLinkPickerOpen}
        excludeId={id}
        onPick={(pickedId, pickedTitle) => {
          editorRef.current?.insertLink(pickedTitle, `/notes/${pickedId}`);
        }}
        onCreate={async (newTitle) => {
          const n = await createNote(null, newTitle);
          if (n) editorRef.current?.insertLink(newTitle, `/notes/${n.id}`);
        }}
      />
    </div>
  );
}

// ─── Search ─────────────────────────────────────────────────────────────────

function SearchDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (id: string) => void;
}) {
  const query = useNotesStore((s) => s.searchQuery);
  const results = useNotesStore((s) => s.searchResults);
  const searching = useNotesStore((s) => s.searching);
  const search = useNotesStore((s) => s.search);
  const clearSearch = useNotesStore((s) => s.clearSearch);

  useEffect(() => {
    if (!open) clearSearch();
  }, [open, clearSearch]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Search className="size-4" /> Search notes
          </DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder="Search by title or content…"
        />
        <div className="max-h-80 space-y-0.5 overflow-auto">
          {searching && <p className="px-1 py-2 text-xs text-muted-foreground">Searching…</p>}
          {!searching &&
            query.trim() &&
            results.map((r) => (
              <button
                key={r.id}
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  onPick(r.id);
                  onOpenChange(false);
                }}
              >
                <span className="truncate text-sm font-medium">{r.title || "Untitled"}</span>
                {r.excerpt && (
                  <span className="truncate text-xs text-muted-foreground">{r.excerpt}</span>
                )}
              </button>
            ))}
          {!searching && query.trim() && results.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">No matches.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Link picker ──────────────────────────────────────────────────────────

/**
 * Search-or-create, for inserting a link to another page. Local state, not
 * the shared searchQuery/searchResults — this dialog and the ⌘P SearchDialog
 * can each open right after the other closes, and neither should see the
 * other's leftover query or results.
 */
function NoteLinkPicker({
  open,
  onOpenChange,
  excludeId,
  onPick,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  excludeId: string;
  onPick: (id: string, title: string) => void;
  onCreate: (title: string) => void | Promise<void>;
}) {
  const findNotes = useNotesStore((s) => s.findNotes);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; title: string; excerpt: string }[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const found = await findNotes(query);
      if (live) {
        setResults(found.filter((r) => r.id !== excludeId));
        setSearching(false);
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, open, excludeId, findNotes]);

  const trimmed = query.trim();
  const exactMatch = results.some((r) => r.title.toLowerCase() === trimmed.toLowerCase());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Link2 className="size-4" /> Link to a page
          </DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title or content…"
        />
        <div className="max-h-80 space-y-0.5 overflow-auto">
          {searching && <p className="px-1 py-2 text-xs text-muted-foreground">Searching…</p>}
          {!searching &&
            results.map((r) => (
              <button
                key={r.id}
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  onPick(r.id, r.title || "Untitled");
                  onOpenChange(false);
                }}
              >
                <span className="truncate text-sm font-medium">{r.title || "Untitled"}</span>
                {r.excerpt && (
                  <span className="truncate text-xs text-muted-foreground">{r.excerpt}</span>
                )}
              </button>
            ))}
          {!searching && trimmed && !exactMatch && (
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onCreate(trimmed);
                onOpenChange(false);
              }}
            >
              <Plus className="size-3.5 text-muted-foreground" />
              Create page: <span className="font-medium">“{trimmed}”</span>
            </button>
          )}
          {!searching && !trimmed && (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              Type to search, or enter a new title to create a page.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
