import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useT } from "@/lib/i18n";
import { enterOrg } from "@/lib/ir-en-org";
import { useEffect, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen, UserPlus } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import DMSwitcher from "@/components/DMSwitcher";
import DMThread from "@/components/DMThread";
import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";
import { usePlacesStore } from "@/store/places.store";
import { Button } from "@/components/ui/button";
import RailItem from "@/components/RailItem";
import { nombreDe } from "@/lib/nombres";
import { useLayoutStore } from "@/store/layout.store";

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
  const abierta = conversationId !== null && conversationOrgId === orgId;
  const [params, setParams] = useSearchParams();
  const c = params.get("c");
  const u = params.get("u");

  // Lo ya atendido, para no reabrir en cada repintado — y sobre todo para no
  // volver a abrirlo si alguien cierra el hilo con la dirección todavía puesta.
  const hecho = useRef<string | null>(null);

  useEffect(() => {
    const pedido = c ? `c:${c}` : u ? `u:${u}` : null;
    if (!pedido || hecho.current === pedido) return;
    hecho.current = pedido;

    // `?c=` puede ser de otra org (el buscador, un aviso): se busca de cuál es
    // y se pone uno en ella antes de abrirla. Sin eso se abría aquí y, con el
    // sello, no se pintaba — o antes del sello, se pintaba en la org que no era.
    const abrirConversacion = async (id: string) => {
      const dm = useDMStore.getState();
      if (!dm.conversations.some((x) => x.conversationId === id)) await dm.fetchConversations();
      const suya = useDMStore.getState().conversations.find((x) => x.conversationId === id)?.orgId;
      if (!enterOrg(suya)) return;
      await open(id, suya);
    };
    const abrir = c ? abrirConversacion(c) : openWith(orgId ?? "", u as string);
    void Promise.resolve(abrir)
      .then(() => {
        // La dirección se limpia en cuanto cumplió. Se queda el hilo abierto,
        // no la orden de abrirlo: dejarla haría que volver atrás en el
        // historial reabriera conversaciones que ya habías cerrado.
        setParams({}, { replace: true });
      })
      .catch((e) => toast.error(String(e)));
  }, [c, u, orgId, open, openWith, setParams]);

  // Sin nada pedido ni abierto, el último directo en el que estuviste en esta
  // org. Si ya no se puede abrir, se cierra, y cerrarlo lo olvida: un enlace
  // muerto no se reintenta en cada visita. Ver `store/places.store.ts`.
  const recordado = usePlacesStore((s) => (orgId ? s.byOrg[orgId]?.dm : undefined));
  useEffect(() => {
    if (c || u || abierta || !recordado || !orgId) return;
    void open(recordado, orgId).catch(() => useDMStore.getState().close());
  }, [c, u, abierta, recordado, orgId, open]);

  // En el teléfono, la lista o la conversación, no las dos: aplastada al lado
  // de la lista, la conversación se leía palabra a palabra. La flecha del hilo
  // (`onBack`) ya vuelve a la lista.
  const movil = useIsMobile();

  // Plegada a un riel con las iniciales de cada persona, como la de canales.
  // Sólo en escritorio, y recordado.
  const plegada = useLayoutStore((s) => !!s.collapsed.dms) && !movil;
  const setCollapsed = useLayoutStore((s) => s.setCollapsed);
  const conversations = useDMStore((s) => s.conversations);
  const fetchConversations = useDMStore((s) => s.fetchConversations);
  // Plegada no se monta `DMSwitcher`, que es quien las pide: sin esto el riel
  // salía vacío al entrar.
  useEffect(() => {
    if (plegada) fetchConversations().catch(() => {});
  }, [plegada, orgId, fetchConversations]);
  const delOrg = plegada ? conversations.filter((x) => x.orgId === orgId) : [];
  const etiqueta = t(plegada ? "common:last.expandList" : "common:last.collapseList");

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r bg-muted/10 transition-[width] duration-200",
          plegada ? "w-14" : "w-60",
          movil && (abierta ? "hidden" : "w-full border-r-0"),
        )}
      >
        <header
          className={cn("flex h-12 shrink-0 items-center border-b", plegada ? "justify-center" : "gap-1 px-3")}
        >
          {!plegada && <span className="flex-1 text-sm font-medium">Direct messages</span>}
          {!movil && (
            <Button
              size="icon-xs"
              variant="ghost"
              title={etiqueta}
              aria-label={etiqueta}
              onClick={() => setCollapsed("dms", !plegada)}
            >
              {plegada ? <PanelLeftOpen className="size-3.5" /> : <PanelLeftClose className="size-3.5" />}
            </Button>
          )}
        </header>
        {plegada ? (
          <nav className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-2">
            {delOrg.map((x) => (
              <RailItem
                key={x.conversationId}
                name={nombreDe(x)}
                active={abierta && x.conversationId === conversationId}
                count={x.unread}
                onClick={() => void open(x.conversationId, x.orgId).catch((e) => toast.error(String(e)))}
              />
            ))}
            {/* Buscar a alguien nuevo pide la lista entera: la despliega. */}
            <Button
              size="icon-sm"
              variant="ghost"
              title={t("common:last.findSomebody")}
              aria-label={t("common:last.findSomebody")}
              onClick={() => setCollapsed("dms", false)}
            >
              <UserPlus className="size-4" />
            </Button>
          </nav>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DMSwitcher onPicked={() => {}} />
          </div>
        )}
      </aside>
      {abierta ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <DMThread onBack={close} />
        </div>
      ) : movil ? null : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("common:misc.pickSomebody")}
        </div>
      )}
    </div>
  );
}
