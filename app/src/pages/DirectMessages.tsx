import { useT } from "@/lib/i18n";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import DMSwitcher from "@/components/DMSwitcher";
import DMThread from "@/components/DMThread";
import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";

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
  const abierta = useDMStore((s) => s.conversationId);
  const open = useDMStore((s) => s.open);
  const openWith = useDMStore((s) => s.openWith);
  const orgId = useOrgsStore((s) => s.currentOrgId);
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

    const abrir = c ? open(c) : openWith(orgId ?? "", u as string);
    void Promise.resolve(abrir)
      .then(() => {
        // La dirección se limpia en cuanto cumplió. Se queda el hilo abierto,
        // no la orden de abrirlo: dejarla haría que volver atrás en el
        // historial reabriera conversaciones que ya habías cerrado.
        setParams({}, { replace: true });
      })
      .catch((e) => toast.error(String(e)));
  }, [c, u, orgId, open, openWith, setParams]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-60 shrink-0 flex-col border-r bg-muted/10">
        <header className="flex h-12 shrink-0 items-center border-b px-3">
          <span className="text-sm font-medium">Direct messages</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DMSwitcher onPicked={() => {}} />
        </div>
      </aside>
      {abierta ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <DMThread onBack={() => useDMStore.setState({ conversationId: null, messages: [] })} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("common:misc.pickSomebody")}
        </div>
      )}
    </div>
  );
}
