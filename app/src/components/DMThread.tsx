import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Pencil, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import Markdown from "@/components/markdown/Markdown";
import { useConfirm } from "@/components/ConfirmDialog";
import { useDMStore } from "@/store/dm.store";
import { useAuthStore } from "@/store/auth.store";
import { cn } from "@/lib/utils";

/**
 * One private conversation, inside the same panel as the channels.
 *
 * A separate component from ChatPanel rather than a mode inside it, mirroring
 * the separate stores and tables. The two read alike on screen, but every
 * question about who may see a line has a different answer, and the way that
 * goes wrong is a shared `messages` array that both halves fill.
 *
 * The composer here offers neither `#` nor `@`: citing a card in a private
 * conversation is reasonable and will come, but naming somebody who cannot see
 * the thread would be a mention that pings a person into a room they may not
 * enter — so it stays off until there is an answer for that.
 */
export default function DMThread({ onBack }: { onBack: () => void }) {
  const messages = useDMStore((s) => s.messages);
  const conversationId = useDMStore((s) => s.conversationId);
  const conversations = useDMStore((s) => s.conversations);
  const loading = useDMStore((s) => s.loading);
  const hasMore = useDMStore((s) => s.hasMore);
  const loadingOlder = useDMStore((s) => s.loadingOlder);
  const fetchOlder = useDMStore((s) => s.fetchOlder);
  const post = useDMStore((s) => s.post);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const heightBefore = useRef<number | null>(null);

  const other = conversations.find((c) => c.conversationId === conversationId);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (heightBefore.current !== null) {
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
    if (!body || sending || !conversationId) return;
    setSending(true);
    try {
      await post(conversationId, body);
      setDraft("");
    } catch (e) {
      // The draft stays put: losing what somebody typed to a network blink is
      // worse than the failure.
      toast.error(String(e));
    } finally {
      setSending(false);
    }
  };

  if (!conversationId) return null;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <button
          className="text-muted-foreground hover:text-foreground"
          title="Back to channels"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
        </button>
        <h2 className="truncate text-sm font-medium">{other?.username ?? "Conversation"}</h2>
        <span className="ml-auto text-xs text-muted-foreground">private</span>
      </header>

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
            Nothing here yet. Only the two of you can read this.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((m, i) => (
              <DMLine
                key={m.id}
                m={m}
                conversationId={conversationId}
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
          minHeight="3rem"
          onSubmit={send}
          placeholder={other ? `Message ${other.username}` : "Message"}
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
    </>
  );
}

function DMLine({
  m,
  conversationId,
  grouped,
}: {
  m: { id: string; authorUserId: string; authorName: string; body: string; createdAt: string; updatedAt: string };
  conversationId: string;
  grouped: boolean;
}) {
  const session = useAuthStore((s) => s.session);
  const edit = useDMStore((s) => s.edit);
  const withdraw = useDMStore((s) => s.withdraw);
  const confirm = useConfirm();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [saving, setSaving] = useState(false);

  // Being in the conversation is not permission to rewrite what the other
  // person said — the same rule the server enforces.
  const mine = session?.id === m.authorUserId;
  const edited = m.updatedAt && m.updatedAt !== m.createdAt;

  useEffect(() => setDraft(m.body), [m.body]);

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    try {
      await edit(conversationId, m.id, body);
      setEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    // Lo propio marcado igual que en un canal: la misma señal en los dos
    // sitios, porque son la misma pregunta —¿esto lo dije yo?— y aprenderla dos
    // veces no tiene sentido.
    <div className={cn("group", mine && "-ml-2 border-l-2 border-primary/60 pl-2")}>
      {!grouped && (
        <div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("font-medium", mine ? "text-primary" : "text-foreground")}>
            {mine ? "You" : m.authorName || "unknown"}
          </span>
          <span>
            {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          {edited && <span className="italic">edited</span>}
        </div>
      )}
      <div
        className={cn(
          "relative rounded-md px-2 py-1 hover:bg-muted/40",
          grouped && "mt-0.5",
          mine && "bg-primary/5",
        )}
      >
        {editing ? (
          <div className="space-y-2">
            <MarkdownEditor value={draft} onChange={setDraft} minHeight="3rem" autoFocus />
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
            <Markdown>{m.body}</Markdown>
            {mine && (
              <div className="absolute -top-1 right-1 flex items-center gap-0.5 rounded-md border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                <button
                  className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="Edit"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                  title="Withdraw"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Withdraw this message?",
                      description: "It stops showing for both of you.",
                      confirmText: "Withdraw",
                      destructive: true,
                    });
                    if (!ok) return;
                    withdraw(conversationId, m.id).catch((e) => toast.error(String(e)));
                  }}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
