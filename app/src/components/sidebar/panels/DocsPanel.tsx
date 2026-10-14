import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import DocsTree from "@/components/docs/DocsTree";
import PanelFilter from "@/components/sidebar/PanelFilter";
import PanelRow from "@/components/sidebar/PanelRow";
import { useT } from "@/lib/i18n";
import { navItem } from "@/lib/nav";
import { useTasksStore } from "@/store/tasks.store";

/**
 * Documentación: la tabla de todos los docs y, debajo, el árbol de espacios
 * con las páginas de cada documento colgando de su nodo.
 *
 * Es lo que hace la navegación de Confluence: el contenido de donde estás
 * aparece en el mismo sidebar, con «buscar por título» arriba, en vez de
 * abrir una segunda columna al lado del texto. El árbol de páginas que tenía
 * `DocTabs` a la izquierda era esa segunda columna.
 */
const ALL_DOCS = navItem("/docs");

export default function DocsPanel() {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const closeDoc = useTasksStore((s) => s.closeDoc);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const [query, setQuery] = useState("");

  return (
    <div className="flex flex-col">
      <div className="px-1">
        <PanelRow
          icon={<ALL_DOCS.icon />}
          label={t(ALL_DOCS.labelKey)}
          // Leyendo un .md del repo (`?repoDoc=`) tampoco es la tabla.
          active={pathname === "/docs" && !activeDoc && !new URLSearchParams(search).has("repoDoc")}
          onClick={() => {
            closeDoc();
            navigate("/docs");
          }}
        />
      </div>
      <PanelFilter value={query} onChange={setQuery} />
      <DocsTree filter={query} />
    </div>
  );
}
