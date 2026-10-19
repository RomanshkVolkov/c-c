import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fold } from "@/lib/task-filter";
import type { ScopeGroup } from "@/lib/scope-options";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * Dónde mira «Mi trabajo», en el teléfono: una hoja con un buscador y los
 * espacios con sus listas debajo. Un desplegable con decenas de listas no se
 * recorre con el dedo (jose, 18-oct-2026); escribiendo «tasks» queda lo que
 * coincide, sin acentos ni mayúsculas, por el nombre de la lista o el del
 * espacio.
 */
export default function ScopeSheet({
  open,
  onOpenChange,
  groups,
  value,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: ScopeGroup[];
  /** `""` es todo; si no, `space:<id>` o `list:<id>` (ver `scopeValue`). */
  value: string;
  onPick: (value: string) => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return groups;
    return groups
      .map((g) =>
        fold(g.label).includes(q) ? g : { ...g, options: g.options.filter((o) => fold(o.label).includes(q)) },
      )
      .filter((g) => g.options.length > 0);
  }, [groups, query]);

  const pick = (v: string) => {
    onPick(v);
    onOpenChange(false);
    setQuery("");
  };
  const row = (v: string, label: string) => (
    <button
      key={v}
      type="button"
      onClick={() => pick(v)}
      aria-pressed={v === value}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm",
        v === value ? "bg-accent font-medium" : "hover:bg-accent/50",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {v === value && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="gap-3 rounded-t-xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] data-[side=bottom]:h-[75dvh]"
      >
        <div className="mx-auto h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />
        <SheetHeader className="p-0">
          <SheetTitle>{t("work:myWork.scopePicker")}</SheetTitle>
          <SheetDescription className="sr-only">{t("work:myWork.scopeSearch")}</SheetDescription>
        </SheetHeader>
        <label className="relative flex items-center">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("work:myWork.scopeSearch")}
            aria-label={t("work:myWork.scopeSearch")}
            className="h-9 w-full rounded-lg border border-input bg-transparent pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring dark:bg-input/30"
          />
        </label>
        <div className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1">
          {!query.trim() && row("", t("work:myWork.everywhere"))}
          {shown.map((g) => (
            <section key={g.label} className="space-y-0.5">
              <p className="px-2.5 text-xs font-medium text-muted-foreground">{g.label}</p>
              {g.options.map((o) => row(o.value, o.label))}
            </section>
          ))}
          {shown.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("work:myWork.scopeNone")}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
