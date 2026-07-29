import { useEffect, useMemo, useState } from "react";
import {
  X,
  Loader2,
  Flag,
  Tag as TagIcon,
  Trash2,
  Check,
  Paperclip,
  Send,
  Calendar,
  Users,
} from "lucide-react";
import { toast } from "sonner";
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
import { mediaSrc } from "@/lib/media";
import { useTasksStore } from "@/store/tasks.store";
import { PRIORITIES, PRIORITY_META } from "@/types/task";
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
  const loading = useTasksStore((s) => s.loadingDetail);
  const closeTask = useTasksStore((s) => s.closeTask);

  if (!openTaskId) return null;

  return (
    <>
      {/* Click-away layer; the drawer itself stops propagation. */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={closeTask} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l bg-background shadow-xl">
        {loading && !detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading task…
          </div>
        ) : !detail ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <p className="text-sm text-muted-foreground">Could not load this task.</p>
            <Button size="sm" variant="outline" onClick={closeTask}>
              Close
            </Button>
          </div>
        ) : (
          <Content />
        )}
      </aside>
    </>
  );
}

function Content() {
  const detail = useTasksStore((s) => s.detail)!;
  const closeTask = useTasksStore((s) => s.closeTask);
  const updateTask = useTasksStore((s) => s.updateTask);
  const deleteTask = useTasksStore((s) => s.deleteTask);
  const addComment = useTasksStore((s) => s.addComment);
  const uploadAttachment = useTasksStore((s) => s.uploadAttachment);
  const deleteAttachment = useTasksStore((s) => s.deleteAttachment);
  const board = useTasksStore((s) => s.board);
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
  const [draft, setDraft] = useState(task.description);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  // Re-sync when the drawer switches to another task.
  useEffect(() => {
    setTitle(task.title);
    setDraft(task.description);
    setEditingDesc(false);
    setComment("");
  }, [task.id, task.title, task.description]);

  const orgTags = useMemo(() => tags.filter((t) => t.orgId === task.orgId), [tags, task.orgId]);

  // Resolve "done"/"open" through the columns' `kind`, never their names: the
  // user is free to rename them.
  const doneStatusIds = useMemo(
    () => new Set((board?.statuses ?? []).filter((s) => s.kind === "done").map((s) => s.id)),
    [board],
  );
  const firstDoneStatusId = (board?.statuses ?? []).find((s) => s.kind === "done")?.id ?? "";
  const firstOpenStatusId = (board?.statuses ?? []).find((s) => s.kind !== "done")?.id ?? "";
  const tagIds = new Set(detail.tags.map((t) => t.id));

  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === task.title) return;
    updateTask(task.id, { title: next }).catch((e) => toast.error(String(e)));
  };

  const upload = async (file: File) => uploadAttachment(task.id, file);

  const send = async () => {
    const body = comment.trim();
    if (!body) return;
    setSending(true);
    try {
      await addComment(task.id, body);
      setComment("");
    } catch (e) {
      toast.error("Could not comment", { description: String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <span className="truncate text-xs text-muted-foreground">
          {detail.spaceName} / {detail.listName}
          {detail.parent && (
            <>
              {" / "}
              <button
                className="underline hover:text-foreground"
                onClick={() => openTask(detail.parent!.id)}
                title="Open parent task"
              >
                #{detail.parent.seq} {detail.parent.title}
              </button>
            </>
          )}
          {" · #"}
          {task.seq}
        </span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={closeTask} aria-label="Close">
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex-1 space-y-5 overflow-auto p-4">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-auto border-0 px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
        />

        {/* Attributes */}
        <div className="grid grid-cols-[7rem_1fr] items-center gap-y-2 text-sm">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Check className="size-3.5" /> Status
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
                    Move to column
                  </DropdownMenuLabel>
                  {(board?.statuses ?? []).map((s) => (
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

          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Flag className="size-3.5" /> Priority
          </span>
          <div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button className={cn("text-xs", PRIORITY_META[task.priority].className)}>
                    {PRIORITY_META[task.priority].label}
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
                      <Flag className={cn("size-3.5", PRIORITY_META[p].className)} />
                      {PRIORITY_META[p].label}
                      {p === task.priority && <Check className="ml-auto size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className="flex items-center gap-1.5 text-muted-foreground">
            <TagIcon className="size-3.5" /> Tags
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {detail.tags.map((t) => (
              <span
                key={t.id}
                className="rounded px-1.5 py-0.5 text-[11px]"
                style={{ backgroundColor: `${t.color || "#8B5CF6"}22`, color: t.color || undefined }}
              >
                {t.name}
              </span>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button className="rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
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
                      const name = await prompt({ title: "New tag", label: "Name", confirmText: "Create" });
                      if (!name) return;
                      const created = await createTag(task.orgId, name, "#8B5CF6");
                      if (created) {
                        updateTask(task.id, {
                          tagIds: [...detail.tags.map((x) => x.id), created.id],
                        }).catch((e) => toast.error(String(e)));
                      }
                    }}
                  >
                    + New tag
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Users className="size-3.5" /> Assignees
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {detail.assignees.map((a) => (
              <Badge key={a.id} variant="secondary" className="gap-1 text-[11px]">
                {a.username}
                <button
                  onClick={() =>
                    updateTask(task.id, {
                      assigneeIds: detail.assignees.filter((x) => x.id !== a.id).map((x) => x.id),
                    }).catch((e) => toast.error(String(e)))
                  }
                  aria-label={`Remove ${a.username}`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <div className="w-44">
              <UserPicker
                placeholder="Assign…"
                onSelect={(u) => {
                  if (detail.assignees.some((a) => a.id === u.id)) return;
                  updateTask(task.id, {
                    assigneeIds: [...detail.assignees.map((a) => a.id), u.id],
                  }).catch((e) => toast.error(String(e)));
                }}
              />
            </div>
          </div>

          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Calendar className="size-3.5" /> Due
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

        {/* Description */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Description
            </h3>
            {!editingDesc && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditingDesc(true)}>
                Edit
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
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDraft(task.description);
                    setEditingDesc(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : task.description ? (
            <Markdown>{task.description}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">No description yet.</p>
          )}
        </section>

        {/* Attachments attached to the task itself */}
        {detail.attachments.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Attachments
            </h3>
            <ul className="space-y-1">
              {detail.attachments.map((a) => (
                <li key={a.id} className="group flex items-center gap-2 text-xs">
                  <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                  <a href={mediaSrc(a.url)} target="_blank" rel="noreferrer" className="truncate text-primary underline">
                    {a.fileName}
                  </a>
                  <span className="shrink-0 text-muted-foreground">{Math.round(a.bytes / 1024)} KB</span>
                  {task.description.includes(a.id) && (
                    <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      in description
                    </span>
                  )}
                  <button
                    className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                    title="Remove attachment"
                    onClick={async () => {
                      const inUse = task.description.includes(a.id);
                      const ok = await confirm({
                        title: `Remove "${a.fileName}"?`,
                        description: inUse
                          ? "It's still referenced from the description — that image will stop loading."
                          : "Removes it from this task's attachment list.",
                        confirmText: "Remove",
                        destructive: true,
                      });
                      if (!ok) return;
                      deleteAttachment(task.id, a.id).catch((e) => toast.error(String(e)));
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Subtasks — a breakdown of this task, sharing the list's columns.
            They stay out of the board's columns so the work isn't counted twice. */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Subtasks{" "}
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
                const t = await prompt({ title: "New subtask", label: "Title", confirmText: "Create" });
                if (t) createSubtask(task.id, t).catch((e) => toast.error(String(e)));
              }}
            >
              + Add
            </Button>
          </div>
          {detail.subtasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Break this task down into steps, or use a checklist in the description.
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {detail.subtasks.map((st) => {
                const done = doneStatusIds.has(st.statusId);
                return (
                  <div key={st.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                    <button
                      title={done ? "Reopen" : "Mark complete"}
                      onClick={() => {
                        // Toggle against the list's own columns, so this works
                        // whatever the user named them.
                        const target = done ? firstOpenStatusId : firstDoneStatusId;
                        if (!target) {
                          toast.error("This list has no column for that");
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
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{st.seq}</span>
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
            <div key={c.id} className="rounded-md border p-2.5">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{c.authorName || "unknown"}</span>
                <span>{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <Markdown>{c.body}</Markdown>
            </div>
          ))}

          <div className="space-y-2">
            <MarkdownEditor
              value={comment}
              onChange={setComment}
              onUpload={upload}
              placeholder="Write a comment… (markdown, paste files)"
              minHeight="5rem"
            />
            <Button size="sm" onClick={send} disabled={sending || !comment.trim()}>
              {sending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
              <span className="ml-1">Comment</span>
            </Button>
          </div>
        </section>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={async () => {
            const ok = await confirm({
              title: `Delete task "${task.title}"?`,
              description: "Removes it with its comments and attachments. This can't be undone.",
              confirmText: "Delete",
              destructive: true,
            });
            if (ok) deleteTask(task.id).catch((e) => toast.error(String(e)));
          }}
        >
          <Trash2 className="size-3 mr-1" /> Delete task
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          Updated {new Date(task.updatedAt).toLocaleString()}
        </span>
      </footer>
    </>
  );
}
