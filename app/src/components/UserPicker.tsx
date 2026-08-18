import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useUsersStore } from "@/store/users.store";
import { useOrgsStore } from "@/store/orgs.store";
import type { UserSummary } from "@/types/collections";
import { cn } from "@/lib/utils";

/**
 * Busca personas por nombre de usuario y devuelve la elegida. Con retardo.
 *
 * `scope` es obligatorio a propósito, porque las dos respuestas son
 * incompatibles y elegir mal rompe en silencio:
 *
 * - `"org"` — colegas. Es lo que hace falta para asignar, mencionar o escribir
 *   a alguien, y **te incluye a ti**.
 * - `"platform"` — todo el mundo. Es lo que hace falta para invitar a alguien
 *   que todavía no está dentro; ahí no tiene sentido ofrecerte a ti mismo y el
 *   servidor te deja fuera.
 *
 * Con un valor por defecto, el selector de responsables se quedó con el de
 * invitar: no podías asignarte una tarea, y te ofrecía gente de otras
 * organizaciones a la que el servidor luego se negaba a asignársela.
 */
export default function UserPicker({
  onSelect,
  scope,
  placeholder = "Search username…",
}: {
  onSelect: (user: UserSummary) => void;
  scope: "org" | "platform";
  placeholder?: string;
}) {
  const search = useUsersStore((s) => s.search);
  const orgId = useOrgsStore((s) => s.currentOrgId);
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
        setResults(await search(q, scope === "org" ? (orgId ?? undefined) : undefined));
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
  }, [query, search, selected, scope, orgId]);

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
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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
                <span className="font-mono text-xs text-muted-foreground">
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
