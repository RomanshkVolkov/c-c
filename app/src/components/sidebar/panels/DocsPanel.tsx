import { useLocation, useNavigate } from "react-router-dom";

import PanelRow from "@/components/sidebar/PanelRow";
import { useT } from "@/lib/i18n";
import { navItem } from "@/lib/nav";
import { useTasksStore } from "@/store/tasks.store";

/**
 * Documentación, de momento: la fila que lleva a la tabla de todos los docs.
 *
 * Es el relleno de la rebanada S0 del sidebar nuevo. En la S2 este panel
 * pasa a llevar el árbol de espacios con las páginas de cada documento, y el
 * árbol lateral de `DocTabs` desaparece.
 */
const ALL_DOCS = navItem("/docs");

export default function DocsPanel() {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const closeDoc = useTasksStore((s) => s.closeDoc);
  const activeDoc = useTasksStore((s) => s.activeDoc);

  return (
    <div className="flex flex-col px-1">
      <PanelRow
        icon={<ALL_DOCS.icon />}
        label={t(ALL_DOCS.labelKey)}
        active={pathname === "/docs" && !activeDoc}
        onClick={() => {
          closeDoc();
          navigate("/docs");
        }}
      />
    </div>
  );
}
