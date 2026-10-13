import { useLocation, useNavigate } from "react-router-dom";

import PanelRow from "@/components/sidebar/PanelRow";
import { useCommsUnread } from "@/hooks/use-comms-unread";
import { useT } from "@/lib/i18n";
import { navItem } from "@/lib/nav";

/**
 * Comunicación, de momento: las dos filas de siempre con sus contadores.
 *
 * Es el relleno de la rebanada S0 del sidebar nuevo. En la S1 este panel
 * pasa a llevar los canales y los directos como dos secciones, y las barras
 * laterales de `/chat` y `/dm` desaparecen.
 */
const ROWS = ["/chat", "/dm"].map(navItem);

export default function CommsPanel() {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { channels, dms } = useCommsUnread();

  return (
    <div className="flex flex-col px-1">
      {ROWS.map((item) => (
        <PanelRow
          key={item.path}
          icon={<item.icon />}
          label={t(item.labelKey)}
          badge={item.path === "/chat" ? channels : dms}
          active={pathname === item.path}
          onClick={() => navigate(item.path)}
        />
      ))}
    </div>
  );
}
