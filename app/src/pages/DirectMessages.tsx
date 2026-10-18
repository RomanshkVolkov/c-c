import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useT } from "@/lib/i18n";
import { enterOrg } from "@/lib/ir-en-org";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import CommsList from "@/components/comms/CommsList";
import DMThread from "@/components/DMThread";
import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";
import { usePlacesStore } from "@/store/places.store";

/**
 * Private conversations, at the same level as the channels.
 *
 * They were reached through a button inside the channel panel, which put
 * "message a person" two screens deep behind "read a channel" and was why
 * nobody could find them. Two people talking is not a mode of a channel.
 *
 * **La conversación abierta va en la dirección**, igual que el canal abierto va
 * en `?space=` en la pantalla de al lado. Sin eso, un enlace a un directo no era
 * un enlace: el buscador mandaba a `/dm?c=<id>` y a `/dm` para una persona, esta
 * pantalla no leía nada, y las dos cosas aterrizaban en la lista pelada — que es
 * exactamente lo que se reportó («no me lleva más que a direct chats»).
 *
 * Dos parámetros porque son dos preguntas distintas:
 *
 * - `?c=<conversationId>` — ábreme **esta** conversación. La sabe quien ya la
 *   tiene delante: el buscador al encontrar un mensaje, una notificación.
 * - `?u=<userId>` — ábreme la conversación **con esta persona**, exista o no.
 *   La sabe quien tiene un nombre y no un hilo. Crearla si hace falta es parte
 *   de la respuesta, no un paso previo que el que enlaza deba dar.
 *
 * La lista de conversaciones ya no es una columna de esta pantalla: en el
 * escritorio vive en el panel de Comunicación del sidebar (12-oct-2026). En el
 * teléfono, donde no hay panel, se ve la lista **o** la conversación.
 */
export default function DirectMessages() {
  const { t } = useT();
  const conversationId = useDMStore((s) => s.conversationId);
  const conversationOrgId = useDMStore((s) => s.conversationOrgId);
  const open = useDMStore((s) => s.open);
  const openWith = useDMStore((s) => s.openWith);
  const close = useDMStore((s) => s.close);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  // Sólo si es de la org en pantalla. Es la comprobación que hace imposible
  // pintar aquí el directo de otra org, venga de donde venga el cambio.
  const isOpen = conversationId !== null && conversationOrgId === orgId;
  const [params, setParams] = useSearchParams();
  const c = params.get("c");
  const u = params.get("u");

  // Lo ya atendido, para no reabrir en cada repintado — y sobre todo para no
  // volver a abrirlo si alguien cierra el hilo con la dirección todavía puesta.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const request = c ? `c:${c}` : u ? `u:${u}` : null;
    if (!request || handled.current === request) return;
    handled.current = request;

    // `?c=` puede ser de otra org (el buscador, un aviso): se busca de cuál es
    // y se pone uno en ella antes de abrirla. Sin eso se abría aquí y, con el
    // sello, no se pintaba — o antes del sello, se pintaba en la org que no era.
    const openConversation = async (id: string) => {
      const dm = useDMStore.getState();
      if (!dm.conversations.some((x) => x.conversationId === id)) await dm.fetchConversations();
      const owner = useDMStore.getState().conversations.find((x) => x.conversationId === id)?.orgId;
      if (!enterOrg(owner)) return;
      await open(id, owner);
    };
    const opening = c ? openConversation(c) : openWith(orgId ?? "", u as string);
    void Promise.resolve(opening)
      .then(() => {
        // La dirección se limpia en cuanto cumplió. Se queda el hilo abierto,
        // no la orden de abrirlo: dejarla haría que volver atrás en el
        // historial reabriera conversaciones que ya habías cerrado.
        setParams({}, { replace: true });
      })
      .catch((e) => toast.error(String(e)));
  }, [c, u, orgId, open, openWith, setParams]);

  // En el teléfono, la lista o la conversación, no las dos: aplastada al lado
  // de la lista, la conversación se leía palabra a palabra. La flecha del hilo
  // (`onBack`) ya vuelve a la lista.
  const mobile = useIsMobile();

  // Sin nada pedido ni abierto, el último directo en el que estuviste en esta
  // org. Si ya no se puede abrir, se cierra, y cerrarlo lo olvida: un enlace
  // muerto no se reintenta en cada visita. Ver `store/places.store.ts`.
  //
  // **Sólo en pantalla ancha.** En el teléfono, entrar a Directos enseña la
  // lista, como Canales: abrir sola la última conversación te dejaba dentro de
  // un hilo que no pediste, sin el menú de abajo (que se esconde en una
  // conversación) y con una flecha como única salida.
  const remembered = usePlacesStore((s) => (orgId ? s.byOrg[orgId]?.dm : undefined));
  useEffect(() => {
    if (mobile || c || u || isOpen || !remembered || !orgId) return;
    void open(remembered, orgId).catch(() => useDMStore.getState().close());
  }, [mobile, c, u, isOpen, remembered, orgId, open]);

  return (
    <div className="flex min-h-0 flex-1">
      {isOpen ? (
        <div className={cn("flex min-h-0 flex-1 flex-col", mobile && "motion-push-in")}>
          <DMThread onBack={close} />
        </div>
      ) : mobile ? (
        <div className="motion-back-in flex min-h-0 flex-1 flex-col">
          <CommsList current="/dm" />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("common:misc.pickSomebody")}
        </div>
      )}
    </div>
  );
}
