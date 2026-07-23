import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useUsersStore } from "@/store/users.store";
import type { UserSummary } from "@/types/collections";
import { cn } from "@/lib/utils";

/**
 * Searches users by username (backed by /users/search) and calls onSelect with
 * the chosen {id, username}. Debounced. Used to invite / add members without the
 * caller having to type a raw user id.
 */
export default function UserPicker({
  onSelect,
  placeholder = "Search username…",
}: {
  onSelect: (user: UserSummary) => void;
  placeholder?: string;
}) {
  const search = useUsersStore((s) => s.search);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<UserSummary | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (selected) return; // don't re-search after a pick
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        setResults(await search(q));
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, search, selected]);

  const pick = (u: UserSummary) => {
    setSelected(u);
    setQuery(u.username);
    setOpen(false);
    onSelect(u);
  };

  const clear = () => {
    setSelected(null);
    setQuery("");
    setResults([]);
  };

  return (
    <div className="relative">
      <div className="relative">
        <Input
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setSelected(null);
            setQuery(e.target.value);
          }}
          onFocus={() => results.length > 0 && !selected && setOpen(true)}
        />
        {loading ? (
          <Loader2 className="absolute right-2 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : selected ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={clear}
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
          {results.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                )}
                onClick={() => pick(u)}
              >
                <span className="flex-1 truncate">{u.username}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {u.id.slice(0, 8)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
