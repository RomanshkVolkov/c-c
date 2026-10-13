import { Hash, Megaphone, Volume2 } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import PanelRow from "@/components/sidebar/PanelRow";
import PanelSection from "@/components/sidebar/PanelSection";
import { useTreeExpansion } from "@/components/sidebar/useTreeExpansion";
import { useCommsUnread } from "@/hooks/use-comms-unread";
import { orderedChannels, resolveSpace } from "@/lib/comms";
import { iniciales } from "@/lib/desde";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth.store";
import { useChatStore } from "@/store/chat.store";
import { useOrgsStore } from "@/store/orgs.store";
import { usePlacesStore } from "@/store/places.store";
import { useTasksStore } from "@/store/tasks.store";
import { useVoice } from "@/store/voice.store";
import type { SpaceTree } from "@/types/task";

export const CHANNELS_SECTION = "section:channels";

/**
 * Los canales de la org: la sala general arriba y separada, y luego el canal
 * de cada espacio, con sus no leídos y quién anda por su voz.
 *
 * Sin «+» en la cabecera: un canal **es** un espacio, y se crea desde Trabajo.
 * Lo único que se abre desde aquí es la sala general, y sólo quien administra.
 *
 * `plain` la pinta sin cabecera plegable, para la lista del teléfono, donde el
 * selector «Canales | Directos» ya dice qué es.
 */
export default function ChannelsSection({ filter = "", plain = false }: { filter?: string; plain?: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const tree = useTasksStore((s) => s.tree);
  const unread = useChatStore((s) => s.unreadBySpace);
  const occupancy = useVoice((s) => s.ocupacion);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const remembered = usePlacesStore((s) => (orgId ? s.byOrg[orgId]?.spaceId : undefined));
  const { channels: unreadTotal } = useCommsUnread();
  const expansion = useTreeExpansion("comms");

  // La fila marcada es la que pinta la página, resuelta por la **misma**
  // función: así nunca se marca un canal que no es el que tienes delante. En
  // la lista del teléfono (`plain`) no se marca ninguna: esa lista ocupa el
  // sitio de la conversación, así que no hay canal en pantalla.
  const onScreen =
    !plain && pathname === "/chat" ? resolveSpace(tree, params.get("space"), remembered)?.id : undefined;

  const { general, rest } = orderedChannels(tree);
  const term = filter.trim().toLowerCase();
  const matches = (s: SpaceTree) => !term || s.name.toLowerCase().includes(term);
  const shownGeneral = general && matches(general) ? general : undefined;
  const shown = rest.filter(matches);
  const any = !!shownGeneral || shown.length > 0;

  if (term && !any) return null;

  const row = (s: SpaceTree) => {
    const inVoice = occupancy[s.id] ?? [];
    const count = unread[s.id] ?? 0;
    const isGeneral = s.kind === "general";
    return (
      <div key={s.id} className={cn(isGeneral && shown.length > 0 && "mb-1 border-b border-sidebar-border pb-1")}>
        <PanelRow
          icon={isGeneral ? <Megaphone /> : <Hash />}
          label={s.name}
          active={s.id === onScreen}
          onClick={() => navigate(`/chat?space=${s.id}`)}
          badge={
            (inVoice.length > 0 || count > 0) && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {/* Alguien hablando ahí dentro. Va antes del contador porque
                    una conversación en curso es más urgente que un mensaje
                    que lleva ahí desde ayer. */}
                {inVoice.length > 0 && (
                  <span
                    title={t("nav:comms.inVoice", { names: inVoice.map((p) => p.name || p.identity).join(", ") })}
                    className="flex items-center gap-0.5 text-[10px] text-success"
                  >
                    <Volume2 className="size-3" />
                    {inVoice.length}
                  </span>
                )}
                {count > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </span>
            )
          }
        />
        {/* Quién está hablando ahí, con nombre y cara, colgando del canal como
            cuelgan en Discord. El número dice «hay dos»; esto dice «son Marta
            y Luis», que es con lo que uno decide si entrar. */}
        {inVoice.length > 0 && (
          <ul className="flex flex-col gap-0.5 py-0.5 pl-7">
            {inVoice.map((p) => (
              <li key={p.identity} className="flex items-center gap-2 px-2 py-0.5">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-[10px] font-semibold text-accent-foreground">
                  {iniciales(p.name || p.identity)}
                </span>
                <span className="truncate text-xs text-foreground">{p.name || p.identity}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const body = (
    <>
      {tree.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">{t("common:last.channelsInSpaces")}</p>
      ) : (
        <>
          {shownGeneral && row(shownGeneral)}
          {shown.map(row)}
        </>
      )}
      {!general && !term && <OpenGeneral />}
    </>
  );

  if (plain) return <div className="flex flex-col gap-0.5 p-1">{body}</div>;

  // Con filtro, una sección plegada que tiene algo se abre: esconder lo que
  // buscas detrás de un chevrón sería no encontrarlo.
  const open = !!term || expansion.isOpen(CHANNELS_SECTION, true);
  return (
    <PanelSection
      label={t("nav:comms.channels")}
      count={unreadTotal}
      open={open}
      onToggle={() => expansion.toggle(CHANNELS_SECTION, true)}
      peek={[...(general ? [general] : []), ...rest]
        .filter((s) => s.id === onScreen || (unread[s.id] ?? 0) > 0)
        .map(row)}
    >
      {body}
    </PanelSection>
  );
}

/**
 * Abrir la sala de toda la organización. Es cosa del admin, y sólo se enseña
 * cuando no existe: el resto no debe ver un botón que le va a responder que
 * no, y ofrecerla cuando ya está sería un botón que miente sobre lo que hace.
 */
function OpenGeneral() {
  const { t } = useT();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const current = useOrgsStore((s) => s.currentOrg());
  const openGeneralRoom = useTasksStore((s) => s.abrirSalaGeneral);
  if (!(superadmin || current?.role === "admin")) return null;

  const onOpen = async () => {
    if (!orgId) return;
    try {
      await openGeneralRoom(orgId);
    } catch (e) {
      toast.error(t("common:last.errGeneralRoom"), { description: String(e) });
    }
  };

  return (
    <PanelRow
      icon={<Megaphone />}
      label={t("nav:comms.openGeneral")}
      onClick={() => void onOpen()}
      className="text-xs"
    />
  );
}
