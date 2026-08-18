import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Hash, MessagesSquare } from "lucide-react";
import ChannelView from "@/components/chat/ChannelView";
import { useTasksStore } from "@/store/tasks.store";
import { useChatStore } from "@/store/chat.store";
import { cn } from "@/lib/utils";

/**
 * Every space's channel, on a screen of its own.
 *
 * It used to be a 320px panel bolted to the right of the board, which made a
 * conversation something that happened beside your work and only while you were
 * looking at Tasks: to read a channel you first had to be on the right screen,
 * and the panel then ate a third of the board.
 *
 * The open channel lives in the address (`?space=`) rather than in a store, so
 * a link to a conversation is a link, and coming back to it restores it.
 */
export default function Channels() {
  const tree = useTasksStore((s) => s.tree);
  const unread = useChatStore((s) => s.unreadBySpace);
  const fetchUnread = useChatStore((s) => s.fetchUnread);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    fetchUnread().catch(() => {});
  }, [fetchUnread]);

  const abierto = params.get("space");
  const espacio = tree.find((s) => s.id === abierto) ?? tree[0];

  // Says which channel is on screen, so the event handler can keep quiet about
  // messages you are watching arrive. It used to read "is the panel open on
  // this space", and with the panel gone that would have been false forever —
  // meaning a notification for every message in the channel you are reading.
  useEffect(() => {
    useChatStore.setState({ panelOpen: !!espacio, spaceId: espacio?.id ?? null });
    return () => useChatStore.setState({ panelOpen: false, spaceId: null });
  }, [espacio]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/10">
        <header className="flex h-12 shrink-0 items-center border-b px-3">
          <span className="text-sm font-medium">Channels</span>
        </header>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-1">
          {tree.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              Channels live in spaces. Create a space to start one.
            </p>
          ) : (
            tree.map((s) => {
              const sinLeer = unread[s.id] ?? 0;
              return (
                <button
                  key={s.id}
                  onClick={() => setParams({ space: s.id })}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                    s.id === espacio?.id
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Hash className="size-3.5 shrink-0" />
                  <span className="truncate">{s.name}</span>
                  {sinLeer > 0 && (
                    <span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground">
                      {sinLeer > 99 ? "99+" : sinLeer}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </nav>
      </aside>

      {espacio ? (
        <ChannelView key={espacio.id} spaceId={espacio.id} spaceName={espacio.name} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <MessagesSquare className="mr-2 size-4" /> Nothing to read yet.
        </div>
      )}
    </div>
  );
}
