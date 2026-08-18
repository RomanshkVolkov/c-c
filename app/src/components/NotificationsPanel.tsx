import { useNavigate } from "react-router-dom";
import { Bell, Check, Trash2, TriangleAlert, Eye, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { useNotificationsStore, type Delivery } from "@/store/notifications.store";
import { useInboxStore, type InboxItem } from "@/store/inbox.store";
import { cn } from "@/lib/utils";

/**
 * What arrived and what the system was told, plus a way to prove the path works.
 *
 * The test button is the point of the panel as much as the list is: an OS
 * notification that doesn't appear could be the app, the permission, the
 * desktop's notification daemon, or a rule in it that silences this app. Trying
 * it on demand and saying what came back separates those, instead of leaving
 * "I didn't see anything" as the only evidence.
 */

const DELIVERY: Record<Delivery, { label: string; icon: typeof Bell; className: string }> = {
  os: { label: "sent to the system", icon: MonitorSmartphone, className: "text-muted-foreground" },
  focused: { label: "you were here", icon: Eye, className: "text-muted-foreground" },
  failed: { label: "not delivered", icon: TriangleAlert, className: "text-destructive" },
};

/**
 * The server's record: what happened, whether or not this app was open.
 *
 * Marking read happens when you click a row rather than when the panel opens.
 * The delivery log below clears itself on open because it is a diagnostic; an
 * inbox that emptied just because you glanced at it would lose the thing you
 * opened it to find.
 */
/** The kinds, in words. An unknown one falls through as its raw name. */
const ETIQUETA: Record<string, string> = {
  "chat:mention": "Mentions",
  "dm:message": "Direct messages",
  "task:comment": "Comments",
  "report:new": "New reports",
};

/** Grouped by kind, each group keeping the newest-first order it arrived in. */
function AGRUPAR(items: InboxItem[]): [string, InboxItem[]][] {
  const by = new Map<string, InboxItem[]>();
  for (const n of items) by.set(n.kind, [...(by.get(n.kind) ?? []), n]);
  return [...by.entries()];
}

function InboxSection() {
  const items = useInboxStore((s) => s.items);
  const unread = useInboxStore((s) => s.unread);
  const markRead = useInboxStore((s) => s.markRead);
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const navigate = useNavigate();

  if (items.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Inbox{unread > 0 ? ` · ${unread} unread` : ""}
        </span>
        {unread > 0 && (
          <button
            className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => void markAllRead()}
          >
            Mark all read
          </button>
        )}
      </div>
      {/* Grouped by what happened, not by when.
          An inbox after a weekend is mostly one kind of thing repeated, and a
          flat list makes you read forty rows to notice that thirty-eight of
          them are the same channel. The groups keep their newest-first order
          inside. */}
      {AGRUPAR(items).map(([tipo, deEste]) => (
      <div key={tipo}>
      <p className="bg-muted/20 px-4 py-1 text-[11px] text-muted-foreground">
        {ETIQUETA[tipo] ?? tipo} · {deEste.length}
      </p>
      <ul className="divide-y">
        {deEste.map((n) => (
          <li key={n.id}>
            <button
              className={cn(
                "flex w-full items-start gap-2 px-4 py-2 text-left hover:bg-accent/40",
                !n.readAt && "bg-primary/5",
              )}
              onClick={() => {
                void markRead([n.id]);
                if (n.link) navigate(n.link);
              }}
            >
              {!n.readAt && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{n.title}</span>
                {n.body && (
                  <span className="block truncate text-xs text-muted-foreground">{n.body}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      </div>
      ))}
    </>
  );
}

export default function NotificationsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const items = useNotificationsStore((s) => s.items);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const clear = useNotificationsStore((s) => s.clear);


  return (
    <Sheet open={open} onOpenChange={(v) => { onOpenChange(v); if (v) markAllRead(); }}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Bell className="size-4" /> Notifications
          </SheetTitle>
        </SheetHeader>

        <div className="flex items-center gap-2 border-b px-4 pb-3">
          {items.length > 0 && (
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={clear}>
              <Trash2 className="mr-1 size-3" /> Clear
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <InboxSection />

          {/* Below the inbox and labelled, because the two answer different
              questions: what happened, and whether this machine managed to tell
              you about it. Merging them would lose the second, which is the only
              way to diagnose a notification that never appeared. */}
          <p className="border-b bg-muted/30 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Delivery log · this session
          </p>
          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              Nothing yet. Everything that arrives is recorded here, whether or not the
              system showed it.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const d = DELIVERY[n.delivery];
                const Icon = d.icon;
                return (
                  <li key={n.id}>
                    <button
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left hover:bg-accent/50",
                        !n.read && "bg-primary/5",
                      )}
                      onClick={() => {
                        if (!n.reportId) return;
                        onOpenChange(false);
                        // The board is where this lives now; the id is the same row.
                        navigate(`/tasks?task=${n.reportId}`);
                      }}
                    >
                      <div className="flex w-full items-center gap-2">
                        <span className="truncate text-sm font-medium">{n.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {new Date(n.at).toLocaleString()}
                        </span>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{n.body}</p>
                      <p className={cn("flex items-center gap-1 text-xs", d.className)}>
                        <Icon className="size-3" />
                        {d.label}
                        {n.error && <span>· {n.error}</span>}
                        <span className="text-muted-foreground/60">· {n.kind}</span>
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {items.some((i) => i.delivery === "focused") && (
          <p className="flex items-start gap-1.5 border-t px-4 py-2 text-xs text-muted-foreground">
            <Check className="mt-0.5 size-3 shrink-0" />
            «You were here» means the window had focus, so it wasn't sent — you'd already
            have seen the toast.
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
