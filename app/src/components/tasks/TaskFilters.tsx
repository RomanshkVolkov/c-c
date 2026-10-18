import { Search, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import Picker from "@/components/ui/picker";
import { EMPTY_FILTER, NOBODY, filterOptions, isFiltering, type FilterableCard, type TaskFilter } from "@/lib/task-filter";

/**
 * La fila de buscar y filtrar de una lista, bajo sus pestañas.
 *
 * La misma para tablero, lista y calendario: cambiar de vista no pierde lo
 * que se estaba buscando. En su propia fila y no al lado de las pestañas,
 * como la de la documentación: ahí, en una ventana normal, los filtros no
 * cabían y se escondían deslizando.
 *
 * Cada desplegable sólo aparece si hay algo que separar (ver
 * `filterOptions`); en una lista recién creada queda sólo el buscador.
 */
export default function TaskFilters({
  cards,
  shown,
  value,
  onChange,
  showCount = true,
}: {
  cards: FilterableCard[];
  /** «Mi trabajo» ya dice cuántas se ven en su cabecera; no lo repite aquí. */
  showCount?: boolean;
  /** Cuántas pasan el filtro, para decir «3 de 12». */
  shown: number;
  value: TaskFilter;
  onChange: (f: TaskFilter) => void;
}) {
  const { t } = useT();
  const opts = filterOptions(cards, value);
  const set = (patch: Partial<TaskFilter>) => onChange({ ...value, ...patch });
  const filtering = isFiltering(value);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b px-4">
      <label className="relative flex w-56 shrink-0 items-center">
        <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
        <input
          type="search"
          value={value.query}
          onChange={(e) => set({ query: e.target.value })}
          // Escape vacía la búsqueda: es lo que se espera de un buscador y
          // ahorra ir al botón de quitar filtros por una sola cosa.
          onKeyDown={(e) => {
            if (e.key === "Escape" && value.query) {
              e.stopPropagation();
              set({ query: "" });
            }
          }}
          placeholder={t("work:board.filter.search")}
          aria-label={t("work:board.filter.search")}
          className="h-7 w-full rounded-md border border-input bg-transparent pr-2 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring dark:bg-input/30"
        />
      </label>

      {opts.assignees.length > 0 && (
        <Picker
          aria-label={t("work:board.filter.anyone")}
          value={value.assignee}
          onChange={(assignee) => set({ assignee })}
          options={[
            { value: "", label: t("work:board.filter.anyone") },
            ...(opts.unassigned ? [{ value: NOBODY, label: t("work:board.filter.nobody") }] : []),
            ...opts.assignees.map((a) => ({ value: a.id, label: a.name })),
          ]}
          size="sm"
          className="text-xs"
        />
      )}
      {opts.priorities.length > 0 && (
        <Picker
          aria-label={t("work:board.filter.anyPriority")}
          value={value.priority}
          onChange={(priority) => set({ priority })}
          options={[
            { value: "", label: t("work:board.filter.anyPriority") },
            ...opts.priorities.map((p) => ({ value: p, label: t(`work:taskPriority.${p}`) })),
          ]}
          size="sm"
          className="text-xs"
        />
      )}
      {opts.tags.length > 0 && (
        <Picker
          aria-label={t("work:board.filter.anyTag")}
          value={value.tag}
          onChange={(tag) => set({ tag })}
          options={[
            { value: "", label: t("work:board.filter.anyTag") },
            ...opts.tags.map((g) => ({ value: g.id, label: g.name })),
          ]}
          size="sm"
          className="text-xs"
        />
      )}
      {/* La clasificación de los reportes: sólo la traen las tarjetas que
          vienen de un cliente, así que en una lista interna no sale. */}
      {opts.categories.length > 0 && (
        <Picker
          aria-label={t("work:board.anyKind")}
          value={value.category}
          onChange={(category) => set({ category })}
          options={[
            { value: "", label: t("work:board.anyKind") },
            ...opts.categories.map((o) => ({ value: o, label: o })),
          ]}
          size="sm"
          className="text-xs capitalize"
        />
      )}
      {opts.areas.length > 0 && (
        <Picker
          aria-label={t("work:board.anyArea")}
          value={value.area}
          onChange={(area) => set({ area })}
          options={[
            { value: "", label: t("work:board.anyArea") },
            ...opts.areas.map((o) => ({ value: o, label: o })),
          ]}
          size="sm"
          className="text-xs capitalize"
        />
      )}

      {filtering && (
        <Button size="xs" variant="ghost" className="shrink-0" onClick={() => onChange(EMPTY_FILTER)}>
          <X className="size-3" /> {t("work:board.filter.clear")}
        </Button>
      )}
      {showCount && (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {filtering
            ? t("work:board.filter.shown", { shown, total: cards.length })
            : t("common:count.tasks", { count: cards.length })}
        </span>
      )}
    </div>
  );
}
