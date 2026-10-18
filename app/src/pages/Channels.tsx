import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useT } from "@/lib/i18n";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { MessagesSquare } from "lucide-react";
import ChannelView from "@/components/chat/ChannelView";
import CommsList from "@/components/comms/CommsList";
import { useTasksStore } from "@/store/tasks.store";
import { useChatStore } from "@/store/chat.store";
import { useEncogerEnLlamada } from "@/components/voice/useEncogerEnLlamada";
import { useOrgsStore } from "@/store/orgs.store";
import { usePlacesStore } from "@/store/places.store";
import { watchOccupancy } from "@/store/voice-occupancy";
import { resolveSpace } from "@/lib/comms";

/**
 * Every space's channel, on a screen of its own.
 *
 * It used to be a 320px panel bolted to the right of the board, which made a
 * conversation something that happened beside your work and only while you were
 * looking at Tasks: to read a channel you first had to be on the right screen,
 * and the panel then ate a third of the board.
 *
 * The open channel lives in the address (`?space=`) rather than in a store, so
 * a link to a conversation is a link, and coming back to it restores it.
 *
 * La lista de canales ya no es una columna de esta pantalla: en el escritorio
 * vive en el panel de Comunicación del sidebar (12-oct-2026), y aquí sólo
 * queda la conversación. En el teléfono, donde no hay panel, la pantalla
 * enseña la lista **o** la conversación.
 */
export default function Channels() {
  const { t } = useT();
  const tree = useTasksStore((s) => s.tree);
  const [params, setParams] = useSearchParams();
  const orgId = useOrgsStore((s) => s.currentOrgId);

  // La ocupación de la voz la pinta la cabecera del canal (`VoiceBar`). La
  // vigila también el panel, pero en el teléfono no hay panel, y con el panel
  // plegado en una llamada esta pantalla es la que queda mirando.
  useEffect(() => watchOccupancy(orgId), [orgId]);

  const requested = params.get("space");
  // El pedido, si no el último en el que estuviste en esta org, y si no la
  // general. Ver `lib/comms.ts` y `store/places.store.ts`.
  const remembered = usePlacesStore((s) => (orgId ? s.byOrg[orgId]?.spaceId : undefined));
  const space = resolveSpace(tree, requested, remembered);

  // Con la sala en pantalla el panel del sidebar se pliega al riel. Lo que
  // devuelve no hace falta aquí: ya no hay columna propia que encoger.
  useEncogerEnLlamada(space?.id ?? null);

  // En el teléfono no caben la lista y la conversación a la vez: se ve una u
  // otra. La conversación sólo cuando se eligió un canal en esta visita
  // (`?space=`); entrar a Canales enseña la lista, y no el último canal
  // recordado, que es lo que hace el escritorio. Volver quita el parámetro.
  const mobile = useIsMobile();
  const conversationOnMobile = mobile && !!requested && !!space;
  const listOnMobile = mobile && !conversationOnMobile;

  // Says which channel is on screen, so the event handler can keep quiet about
  // messages you are watching arrive. It used to read "is the panel open on
  // this space", and with the panel gone that would have been false forever —
  // meaning a notification for every message in the channel you are reading.
  useEffect(() => {
    // En el teléfono, con sólo la lista en pantalla, no se está mirando ningún
    // canal: sus mensajes tienen que avisar.
    useChatStore.setState({ panelOpen: !!space && !listOnMobile, spaceId: space?.id ?? null });
    // Bajo la org del canal, que es la del árbol.
    if (space) usePlacesStore.getState().remember(space.orgId, { spaceId: space.id });
    return () => useChatStore.setState({ panelOpen: false, spaceId: null });
  }, [space, listOnMobile]);

  return (
    <div className="flex min-h-0 flex-1">
      {listOnMobile ? (
        <div className={cn("flex min-h-0 flex-1 flex-col", mobile && "motion-back-in")}>
          <CommsList current="/chat" />
        </div>
      ) : space ? (
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", mobile && "motion-push-in")}>
        <ChannelView
          key={space.id}
          spaceId={space.id}
          spaceName={space.name}
          onBack={mobile ? () => setParams({}) : undefined}
        />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <MessagesSquare className="mr-2 size-4" /> {t("nav:comms.nothingToRead")}
        </div>
      )}
    </div>
  );
}
