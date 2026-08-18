import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Loader2, KanbanSquare, NotebookPen, User, Hash, MessageSquare } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useOrgsStore } from "@/store/orgs.store";
import type { APIResponse } from "@/types/auth";
import { cn } from "@/lib/utils";

/**
 * ⌘K: one box for everything.
 *
 * The results arrive from the server already separated by source and are shown
 * that way, rather than merged into one ranked list. That is not a display
 * choice — every source has a different rule about who may see it, and keeping
 * them apart is what lets each be fenced by itself. A single list would invite
 * a single query, and the first person to add a source would have to rediscover
 * four authorization rules to keep it honest.
 *
 * No message bodies beyond a one-line snippet: this is for finding a thing, not
 * for reading it somewhere it wasn't meant to be read.
 */

interface Hit {
  kind: string;
  id: string;
  title: string;
  where?: string;
  link: string;
}

interface Results {
  tasks: Hit[];
  notes: Hit[];
  people: Hit[];
  messages: Hit[];
  dms: Hit[];
}

const VACIO: Results = { tasks: [], notes: [], people: [], messages: [], dms: [] };

const GRUPOS: { key: keyof Results; label: string; icon: typeof Search }[] = [
  { key: "tasks", label: "Tasks", icon: KanbanSquare },
  { key: "messages", label: "Channels", icon: Hash },
  { key: "dms", label: "Direct messages", icon: MessageSquare },
  { key: "notes", label: "Notes", icon: NotebookPen },
  { key: "people", label: "People", icon: User },
];

export default function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Results>(VACIO);
  const [loading, setLoading] = useState(false);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const navigate = useNavigate();
  const pedido = useRef(0);

  useEffect(() => {
    if (!open) {
      setQ("");
      setRes(VACIO);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setRes(VACIO);
      return;
    }
    // Debounced, and every answer carries the number of the request that asked
    // for it: typing fast otherwise lets a slow early reply land on top of a
    // later one, and the list shows results for a query nobody is looking at.
    const mio = ++pedido.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const org = orgId ? `orgId=${orgId}&` : "";
        const r = await api.get<APIResponse<Results>>(
          `/api/v1/search/?${org}q=${encodeURIComponent(q)}`,
          true,
        );
        if (mio === pedido.current) setRes(r.data ?? VACIO);
      } catch {
        if (mio === pedido.current) setRes(VACIO);
      } finally {
        if (mio === pedido.current) setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q, open, orgId]);

  const total = GRUPOS.reduce((n, g) => n + res[g.key].length, 0);

  const ir = (link: string) => {
    onOpenChange(false);
    navigate(link);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[15%] max-w-xl translate-y-0 gap-0 p-0" showCloseButton={false}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tasks, messages, notes, people…"
            aria-label="Search"
            className="h-11 w-full bg-transparent text-sm outline-none"
          />
          {loading && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-1">
          {q.trim().length < 2 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              Type at least two letters.
            </p>
          ) : total === 0 && !loading ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing found.</p>
          ) : (
            GRUPOS.map((g) =>
              res[g.key].length === 0 ? null : (
                <section key={g.key} className="mb-1">
                  <p className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {g.label}
                  </p>
                  {res[g.key].map((h) => (
                    <button
                      key={`${g.key}-${h.id}`}
                      onClick={() => ir(h.link)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm",
                        "hover:bg-accent",
                      )}
                    >
                      <g.icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{h.title}</span>
                      {h.where && (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {h.where}
                        </span>
                      )}
                    </button>
                  ))}
                </section>
              ),
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
