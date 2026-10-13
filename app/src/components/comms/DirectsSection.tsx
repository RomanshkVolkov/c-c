import { useState } from "react";
import { UserPlus } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import NewConversation from "@/components/comms/NewConversation";
import PresenceDot from "@/components/PresenceDot";
import PanelRow from "@/components/sidebar/PanelRow";
import PanelSection from "@/components/sidebar/PanelSection";
import { useTreeExpansion } from "@/components/sidebar/useTreeExpansion";
import { useCommsUnread } from "@/hooks/use-comms-unread";
import { useT } from "@/lib/i18n";
import { nombreDe } from "@/lib/nombres";
import { useDMStore, type DMSummary } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";

export const DIRECTS_SECTION = "section:directs";

/**
 * Las conversaciones privadas de esta org, con quién anda por aquí y sus no
 * leídos, y «Nueva conversación» para escribirle a alguien con quien todavía
 * no hay hilo.
 *
 * **Sólo las de esta organización.** El servidor devuelve las de todas —una
 * consulta por org para pintar una lista sería absurdo—, así que quedarse con
 * las de aquí es trabajo de la lista. Sin eso se mezclaba en la misma columna
 * gente de dos clientes distintos.
 *
 * `plain` la pinta sin cabecera plegable, para la lista del teléfono.
 */
export default function DirectsSection({ filter = "", plain = false }: { filter?: string; plain?: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const conversations = useDMStore((s) => s.conversations);
  const conversationId = useDMStore((s) => s.conversationId);
  const conversationOrgId = useDMStore((s) => s.conversationOrgId);
  const open = useDMStore((s) => s.open);
  const { dms: unreadTotal } = useCommsUnread();
  const expansion = useTreeExpansion("comms");
  const [picking, setPicking] = useState(false);

  const term = filter.trim().toLowerCase();
  const matches = (c: DMSummary) =>
    !term || nombreDe(c).toLowerCase().includes(term) || c.username.toLowerCase().includes(term);
  const shown = conversations.filter((c) => c.orgId === orgId && matches(c));

  if (term && shown.length === 0) return null;

  // Abierta sólo si es de la org en pantalla: el mismo sello con el que la
  // página decide si la pinta (`DirectMessages.tsx`).
  const onScreen = pathname === "/dm" && conversationOrgId === orgId ? conversationId : null;

  const go = (c: DMSummary) => {
    void open(c.conversationId, c.orgId).catch((e) => toast.error(String(e)));
    if (pathname !== "/dm") navigate("/dm");
  };

  const row = (c: DMSummary) => (
    <PanelRow
      key={c.conversationId}
      icon={<PresenceDot lastSeenAt={c.lastSeenAt} />}
      label={nombreDe(c)}
      badge={c.unread}
      active={c.conversationId === onScreen}
      onClick={() => go(c)}
    />
  );

  const body = (
    <>
      {shown.map(row)}
      {!term && (
        <PanelRow
          icon={<UserPlus />}
          label={t("nav:comms.newConversation")}
          onClick={() => setPicking(true)}
          className="text-xs"
        />
      )}
      <NewConversation open={picking} onOpenChange={setPicking} onPicked={() => navigate("/dm")} />
    </>
  );

  if (plain) return <div className="flex flex-col gap-0.5 p-1">{body}</div>;

  const isOpen = !!term || expansion.isOpen(DIRECTS_SECTION, true);
  return (
    <PanelSection
      label={t("nav:comms.directs")}
      count={unreadTotal}
      open={isOpen}
      onToggle={() => expansion.toggle(DIRECTS_SECTION, true)}
      peek={shown.filter((c) => c.conversationId === onScreen || c.unread > 0).map(row)}
    >
      {body}
    </PanelSection>
  );
}
