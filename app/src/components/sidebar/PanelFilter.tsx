import { Search, X } from "lucide-react";

import { SidebarInput } from "@/components/ui/sidebar";
import { useT } from "@/lib/i18n";

/**
 * El filtro por título de un panel, como el «Search by title» de Confluence.
 *
 * Filtra lo que ya está en pantalla; no es la búsqueda (⌘K), que pregunta al
 * servidor y cruza tareas, mensajes y gente. Una lista de veinte espacios o
 * de cuarenta canales se recorre mejor escribiendo tres letras que haciendo
 * scroll, y eso es todo lo que esto promete.
 */
export default function PanelFilter({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const { t } = useT();
  const label = placeholder ?? t("nav:panel.filter");
  return (
    <div className="relative px-2 py-1">
      <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <SidebarInput
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="h-7 pl-7 pr-7 text-xs"
      />
      {value && (
        <button
          type="button"
          aria-label={t("nav:panel.clearFilter")}
          onClick={() => onChange("")}
          className="absolute right-4 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
