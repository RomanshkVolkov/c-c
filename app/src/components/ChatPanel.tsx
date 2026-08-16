import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Send, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import Markdown from "@/components/markdown/Markdown";
import { taskIdFromHref } from "@/components/markdown/card-menu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useChatStore } from "@/store/chat.store";
import { usePeopleStore } from "@/store/people.store";
import { useDMStore } from "@/store/dm.store";
import DMThread from "@/components/DMThread";
import DMSwitcher from "@/components/DMSwitcher";
import { userIdFromHref } from "@/components/markdown/mention-menu";
import type { ChatMessage } from "@/store/chat.store";
import { useAuthStore } from "@/store/auth.store";
import { useTasksStore } from "@/store/tasks.store";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ItemVisibility } from "@/types/task";

/**
 * The space's channel, beside the board rather than on top of it.
 *
 * A panel and not a tab, because the whole reason to build this instead of
 * using Slack is proximity: you talk about the cards while looking at them. A
 * tab would have made it a worse Slack in a window you have to leave.
 *
 * Known collision, accepted for v1: the task drawer also opens on the right and
 * covers this. Opening a card from the chat therefore hides the chat. Fixing it
 * properly means a two-column right rail, which is a layout change larger than
 * the feature.
 */
export default function ChatPanel({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const hasMore = useChatStore((s) => s.hasMore);
  const loadingOlder = useChatStore((s) => s.loadingOlder);
  const openSpaceId = useChatStore((s) => s.spaceId);
  const closePanel = useChatStore((s) => s.closePanel);
  const fetch = useChatStore((s) => s.fetch);
  const fetchOlder = useChatStore((s) => s.fetchOlder);
  const markRead = useChatStore((s) => s.markRead);
  const post = useChatStore((s) => s.post);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Reads the store at call time — see the `cards` prop on MarkdownEditor.
  const citableCards = useCallback(
    () =>
      (useTasksStore.getState().board?.tasks ?? []).map((t) => ({
        id: t.id,
        seq: t.seq,
        title: t.title,
      })),
    [],
  );
  // Colleagues for the `@` picker, read at trigger time like the cards.
  const fetchPeople = usePeopleStore((s) => s.fetchPeople);
  const people = useCallback(() => usePeopleStore.getState().current(), []);
  useEffect(() => {
    fetchPeople().catch(() => {});
  }, [fetchPeople]);

  const scroller = useRef<HTMLDivElement>(null);
  // How tall the list was before an older page landed, so the view can stay put.
  const heightBefore = useRef<number | null>(null);

  // Following the space the person navigated to.
  useEffect(() => {
    if (openSpaceId === spaceId) return;
    fetch(spaceId)
      .then(() => markRead(spaceId))
      .catch((e) => toast.error(String(e)));
  }, [spaceId, openSpaceId, fetch, markRead]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (heightBefore.current !== null) {
      // An older page was prepended. Jumping to the bottom here would throw the
      // person back down to the newest message every time they scroll up.
      el.scrollTop = el.scrollHeight - heightBefore.current;
      heightBefore.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || el.scrollTop > 40 || !hasMore || loadingOlder) return;
    heightBefore.current = el.scrollHeight;
    fetchOlder().catch((e) => toast.error(String(e)));
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await post(spaceId, body);
      setDraft("");
    } catch (e) {
      // The draft stays in the box: losing what someone typed because the
      // network blinked is worse than the failure itself.
      toast.error(String(e));
    } finally {
      setSending(false);
    }
  };

  const upload = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await api.postForm<{ data: { url: string; fileName: string } }>(
        `/api/v1/task-spaces/${spaceId}/chat/attachments`,
        form,
      );
      return { url: res.data.url, fileName: res.data.fileName };
    } catch (e) {
      toast.error(String(e));
      return null;
    }
  };

  // A conversation open means the panel is showing it instead of the channel.
  // Held in the DM store rather than here so a message arriving can put you in
  // the right place without this component knowing how.
  const dmOpen = useDMStore((s) => s.conversationId);
  const [pickingPerson, setPickingPerson] = useState(false);

  if (dmOpen) {
    return (
      <aside className="flex w-80 shrink-0 flex-col border-l bg-background xl:w-96">
        <DMThread onBack={() => useDMStore.setState({ conversationId: null, messages: [] })} />
      </aside>
    );
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background xl:w-96">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="truncate text-sm font-medium">#{spaceName}</h2>
        <button
          className="ml-auto text-muted-foreground hover:text-foreground"
          title="Direct messages"
          onClick={() => setPickingPerson((v) => !v)}
        >
          <Users className="size-4" />
        </button>
        <button
          className="text-muted-foreground hover:text-foreground"
          title="Close chat"
          onClick={closePanel}
        >
          <X className="size-4" />
        </button>
      </header>

      {pickingPerson && <DMSwitcher onPicked={() => setPickingPerson(false)} />}

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-3">
        {loadingOlder && (
          <div className="flex justify-center pb-2">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {loading && messages.length === 0 ? (
          <div className="flex justify-center pt-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="pt-6 text-center text-xs text-muted-foreground">
            Nothing here yet. This channel is only for the team — it never reaches a client.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((m, i) => (
              <Message
                key={m.id}
                m={m}
                spaceId={spaceId}
                spaceName={spaceName}
                onUpload={upload}
                cards={citableCards}
                people={people}
                // Consecutive lines from one person read as one turn of speech.
                grouped={i > 0 && messages[i - 1].authorUserId === m.authorUserId}
              />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t p-2">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          onUpload={upload}
          // The cards of whichever board is open, read when `#` is typed rather
          // than captured now: the composer outlives the board it was mounted
          // beside.
          cards={citableCards}
          people={people}
          minHeight="3rem"
          // The rule that keeps the four ways of writing in cac apart, said
          // where the decision is actually made rather than in a doc nobody
          // opens. If people don't know where to write, the feature failed.
          placeholder="Message the team — # cites a card, @ names somebody"
        />
        <div className="mt-1 flex justify-end">
          <Button size="sm" onClick={send} disabled={sending || !draft.trim()}>
            {sending ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <Send className="mr-1 size-3" />
            )}
            Send
          </Button>
        </div>
      </div>
    </aside>
  );
}

function Message({
  m,
  spaceId,
  spaceName,
  grouped,
  onUpload,
  cards,
  people,
}: {
  m: ChatMessage;
  spaceId: string;
  spaceName: string;
  grouped: boolean;
  // Editing is composing: the same citation picker and the same image upload,
  // or fixing a typo in a message that has an image would drop it.
  onUpload: (file: File) => Promise<{ url: string; fileName: string } | null>;
  cards: () => { id: string; seq: number; title: string }[];
  people: () => { id: string; username: string }[];
}) {
  const session = useAuthStore((s) => s.session);
  const edit = useChatStore((s) => s.edit);
  const withdraw = useChatStore((s) => s.withdraw);
  const openTask = useTasksStore((s) => s.openTask);
  const confirm = useConfirm();

  /**
   * A cited card opens in the drawer instead of navigating.
   *
   * Returning true claims the click; anything else falls through to the
   * attachment and browser paths Markdown already has, so an ordinary link in a
   * message still behaves like a link.
   */
  const openCited = (href: string) => {
    const id = taskIdFromHref(href);
    if (id) {
      openTask(id).catch((e) => toast.error(String(e)));
      return true;
    }
    // A mention names a person rather than pointing somewhere. Claimed anyway,
    // so the click doesn't fall through to the attachment and browser paths and
    // try to open "cac:user/…" as a file.
    return userIdFromHref(href) !== null;
  };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [saving, setSaving] = useState(false);

  // Only the author edits or withdraws. A superadmin may too, but the button is
  // not offered — the server allows it for cleanup, the UI doesn't invite it.
  const mine = session?.id === m.authorUserId;
  const edited = m.updatedAt && m.updatedAt !== m.createdAt;

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    try {
      await edit(spaceId, m.id, body);
      setEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="group">
      {!grouped && (
        <div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{m.authorName || "unknown"}</span>
          <span>
            {new Date(m.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {edited && <span className="italic">edited</span>}
        </div>
      )}
      <div className={cn("relative rounded-md px-2 py-1 hover:bg-muted/40", grouped && "mt-0.5")}>
        {editing ? (
          <div className="space-y-2">
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              onUpload={onUpload}
              cards={cards}
              people={people}
              minHeight="3rem"
              autoFocus
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={saving || !draft.trim()}>
                {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Markdown onInternalLink={openCited}>{m.body}</Markdown>
            <div className="absolute right-1 top-0 flex items-center gap-1 rounded border bg-background px-1 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
              <MessageToTask body={m.body} spaceId={spaceId} spaceName={spaceName} />
              {mine && (
                <>
                  <button
                    className="text-muted-foreground hover:text-foreground"
                    title="Edit"
                    onClick={() => {
                      setDraft(m.body);
                      setEditing(true);
                    }}
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    className="text-muted-foreground hover:text-destructive"
                    title="Withdraw"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Withdraw this message?",
                        description: "It stops showing in the channel for everyone.",
                        confirmText: "Withdraw",
                        destructive: true,
                      });
                      if (!ok) return;
                      withdraw(spaceId, m.id).catch((e) => toast.error(String(e)));
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Turn a message into a card in the list currently open.
 *
 * Deliberately no list picker: the target is the board you are looking at, and
 * the button says so. A picker would be a second tree to navigate inside a
 * 320px panel to save one drag.
 *
 * It goes through the same visibility question the board asks, rather than
 * around it. A message written in an internal channel becoming a card a client
 * can read is exactly the leak this whole feature was designed to make
 * impossible, and skipping the prompt "because chat is internal" would be the
 * one code path that does it.
 */
function MessageToTask({
  body,
  spaceId,
  spaceName,
}: {
  body: string;
  spaceId: string;
  spaceName: string;
}) {
  const activeListId = useTasksStore((s) => s.activeListId);
  const tree = useTasksStore((s) => s.tree);
  const createTask = useTasksStore((s) => s.createTask);
  const confirm = useConfirm();

  // The list has to belong to this space: a card made from #portento's channel
  // landing on a list of another client's board is a mistake with a blast
  // radius, so it is refused rather than warned about.
  const space = tree.find((s) => s.id === spaceId);
  const inThisSpace = Boolean(
    space &&
      activeListId &&
      (space.lists.some((l) => l.id === activeListId) ||
        space.folders.some((f) => f.lists.some((l) => l.id === activeListId))),
  );

  const channelOfList = (() => {
    if (!space || !activeListId) return undefined;
    for (const l of space.lists) if (l.id === activeListId) return l.projectId ?? space.projectId;
    for (const f of space.folders) {
      for (const l of f.lists) if (l.id === activeListId) return l.projectId ?? space.projectId;
    }
    return undefined;
  })();

  const title = firstLine(body);

  return (
    <button
      className={cn(
        "text-muted-foreground hover:text-foreground",
        !inThisSpace && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
      )}
      title={
        inThisSpace
          ? "Create a task from this message"
          : `Open a list in #${spaceName} to turn messages into tasks`
      }
      onClick={async () => {
        if (!inThisSpace) return;
        let visibility: ItemVisibility | undefined;
        if (channelOfList) {
          const share = await confirm({
            title: "Can the client see this?",
            description:
              "This came from the team's channel, which the client never sees. Making the card " +
              "visible puts its text on their board and takes one of their ticket numbers.",
            confirmText: "Visible to them",
            cancelText: "Internal",
          });
          visibility = share ? "public" : "internal";
        }
        // The whole message becomes the body, not just the title line — the
        // detail is usually in the lines after the first, and a card that
        // dropped them would send people back to the channel to re-read it.
        const description = `${body}\n\n— from the #${spaceName} channel`;
        createTask(title, undefined, visibility, description).catch((e) =>
          toast.error(String(e)),
        );
      }}
    >
      <Plus className="size-3" />
    </button>
  );
}

/** A card needs a title, and a message's first line is the closest thing it has. */
function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "Message";
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}
