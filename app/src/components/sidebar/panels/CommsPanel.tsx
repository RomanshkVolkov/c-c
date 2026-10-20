import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import ChannelsSection from "@/components/comms/ChannelsSection";
import DirectsSection from "@/components/comms/DirectsSection";
import PanelFilter from "@/components/sidebar/PanelFilter";
import PanelRow from "@/components/sidebar/PanelRow";
import { useCommsData } from "@/hooks/use-comms-data";
import { useT } from "@/lib/i18n";
import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { usePostsStore } from "@/store/posts.store";
import { nombreDe } from "@/lib/nombres";

/**
 * Comunicación: los canales y los directos en el mismo panel, como en Slack.
 *
 * Sustituye a las dos columnas que abrían `/chat` y `/dm` cada una por su
 * lado, con su propio plegado. Aquí son dos secciones que se pliegan pulsando
 * la cabecera y se recuerdan por org, y de un canal a un directo hay un clic,
 * no un cambio de pantalla para buscar la lista.
 *
 * El filtro de arriba casa canales por nombre y personas por nombre y
 * usuario. No es la búsqueda (⌘K): sólo recorta lo que ya está en pantalla.
 */
export default function CommsPanel() {
  const { t } = useT();
  const [query, setQuery] = useState("");
  useCommsData();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // El muro (#189), con un punto si hay algo publicado desde que se abrió. Se
  // pide una vez; lo que llega después lo trae el stream.
  const wallLoaded = usePostsStore((s) => s.loaded);
  const wallNew = usePostsStore((s) => s.hasNew);
  useEffect(() => {
    if (!wallLoaded) void usePostsStore.getState().load().catch(() => {});
  }, [wallLoaded]);

  const term = query.trim().toLowerCase();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  // Sólo para el «nada coincide»: cada sección filtra lo suyo.
  const anything = useTasksStore((s) => !term || s.tree.some((sp) => sp.name.toLowerCase().includes(term)));
  const anyone = useDMStore(
    (s) =>
      !term ||
      s.conversations.some(
        (c) =>
          c.orgId === orgId &&
          (nombreDe(c).toLowerCase().includes(term) || c.username.toLowerCase().includes(term)),
      ),
  );

  return (
    <div className="flex flex-col">
      <PanelFilter value={query} onChange={setQuery} placeholder={t("nav:comms.filter")} />
      <div className="px-1">
        <PanelRow
          icon={<Megaphone />}
          label={t("nav:item.feedback")}
          active={pathname.startsWith("/feedback")}
          onClick={() => navigate("/feedback")}
          badge={
            wallNew ? (
              <span className="size-2 rounded-full bg-primary" role="img" aria-label={t("common:feedback.new")} />
            ) : undefined
          }
        />
      </div>
      <ChannelsSection filter={query} />
      <DirectsSection filter={query} />
      {!anything && !anyone && <p className="px-3 py-2 text-xs text-muted-foreground">{t("nav:panel.noMatches")}</p>}
    </div>
  );
}
