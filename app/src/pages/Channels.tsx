import { useT } from "@/lib/i18n";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Hash, Megaphone, MessagesSquare, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/auth.store";
import { iniciales } from "@/lib/desde";
import ChannelView from "@/components/chat/ChannelView";
import { useTasksStore } from "@/store/tasks.store";
import { useChatStore } from "@/store/chat.store";
import { useVoice } from "@/store/voice.store";
import { useEncogerEnLlamada } from "@/components/voice/useEncogerEnLlamada";
import { useOrgsStore } from "@/store/orgs.store";
import { cn } from "@/lib/utils";

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
 */
export default function Channels() {
  const { t } = useT();
  const tree = useTasksStore((s) => s.tree);
  const unread = useChatStore((s) => s.unreadBySpace);
  const fetchUnread = useChatStore((s) => s.fetchUnread);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    fetchUnread().catch(() => {});
  }, [fetchUnread]);

  // Quién anda por los canales de voz, mientras esta pantalla está abierta.
  //
  // Se pregunta cada quince segundos en vez de escuchar eventos: la ocupación
  // sólo importa para decidir si entrar, y quince segundos de retraso en esa
  // decisión no los nota nadie. Un canal de webhooks con estado propio para
  // esto sería mucha maquinaria por muy poco, y una que puede mentir.
  const ocupacion = useVoice((s) => s.ocupacion);
  const refrescarOcupacion = useVoice((s) => s.refrescarOcupacion);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  useEffect(() => {
    void refrescarOcupacion(orgId);
    const t = setInterval(() => void refrescarOcupacion(orgId), 15_000);
    return () => clearInterval(t);
  }, [refrescarOcupacion, orgId]);

  // Abrir la sala de toda la organización es de quien la administra.
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const orgActual = useOrgsStore((s) => s.currentOrg());
  const puedeAbrirla = superadmin || orgActual?.role === "admin";
  const abrirSalaGeneral = useTasksStore((s) => s.abrirSalaGeneral);
  const abrirGeneral = async () => {
    if (!orgId) return;
    try {
      await abrirSalaGeneral(orgId);
    } catch (e) {
      toast.error(t("common:last.errGeneralRoom"), { description: String(e) });
    }
  };

  const abierto = params.get("space");
  /**
   * La sala de toda la organización, y los canales de cada espacio.
   *
   * Va anclada arriba y separada: es de todos, mientras que cada canal de abajo
   * es de un trabajo concreto. Y es el primer sitio razonable al que llevar a
   * quien entra sin haber elegido nada.
   */
  const general = tree.find((s) => s.kind === "general");
  const canales = tree.filter((s) => s.kind !== "general");
  const espacio = tree.find((s) => s.id === abierto) ?? general ?? tree[0];

  // Con la sala en pantalla esta columna sobra, y el rail también.
  const encogido = useEncogerEnLlamada(espacio?.id ?? null);

  // Says which channel is on screen, so the event handler can keep quiet about
  // messages you are watching arrive. It used to read "is the panel open on
  // this space", and with the panel gone that would have been false forever —
  // meaning a notification for every message in the channel you are reading.
  useEffect(() => {
    useChatStore.setState({ panelOpen: !!espacio, spaceId: espacio?.id ?? null });
    return () => useChatStore.setState({ panelOpen: false, spaceId: null });
  }, [espacio]);

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        // A cero en vez de desmontada: desmontar pierde el foco y corta la
        // transición en seco. `inert` es lo que impide que quede una columna
        // invisible pero tabulable, que es peor que dejarla a la vista.
        inert={encogido}
        className={cn(
          "flex shrink-0 flex-col overflow-hidden bg-muted/10 transition-[width] duration-200",
          encogido ? "w-0 border-r-0" : "w-60 border-r",
        )}
      >
        <header className="flex h-12 shrink-0 items-center border-b px-3">
          <span className="text-sm font-medium">{t("common:last.channels")}</span>
        </header>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-1">
          {tree.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t("common:last.channelsInSpaces")}
            </p>
          ) : (
            [...(general ? [general] : []), ...canales].map((s) => {
              const sinLeer = unread[s.id] ?? 0;
              const enVoz = ocupacion[s.id] ?? [];
              const esGeneral = s.kind === "general";
              return (
                <div key={s.id} className={cn(esGeneral && canales.length > 0 && "mb-1 border-b pb-1")}>
                <button
                  onClick={() => setParams({ space: s.id })}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                    s.id === espacio?.id
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {esGeneral ? (
                    <Megaphone className="size-3.5 shrink-0" />
                  ) : (
                    <Hash className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{s.name}</span>
                  {/* Alguien hablando ahí dentro. Va antes del contador de no
                      leídos porque una conversación en curso es más urgente
                      que un mensaje que lleva ahí desde ayer. */}
                  {enVoz.length > 0 && (
                    <span
                      title={`In voice: ${enVoz.map((p) => p.name || p.identity).join(", ")}`}
                      className="ml-auto flex shrink-0 items-center gap-0.5 text-[10px] text-success"
                    >
                      <Volume2 className="size-3" />
                      {enVoz.length}
                    </span>
                  )}
                  {sinLeer > 0 && (
                    <span className={cn(
                      "rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground",
                      enVoz.length === 0 && "ml-auto",
                    )}>
                      {sinLeer > 99 ? "99+" : sinLeer}
                    </span>
                  )}
                </button>

                {/* Quién está hablando ahí, con nombre y cara, colgando del
                    canal como cuelgan en Discord.
                    
                    El contador de la fila dice «hay dos»; esto dice «son Marta
                    y Luis», que es la información con la que uno decide si
                    entrar. Un número no distingue una reunión a la que te
                    llamaban de una charla que no va contigo. */}
                {enVoz.length > 0 && (
                  <ul className="flex flex-col gap-0.5 py-0.5 pl-6">
                    {enVoz.map((p) => (
                      <li key={p.identity} className="flex items-center gap-2 px-2 py-0.5">
                        <span className="grid size-5.5 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-semibold text-accent-foreground">
                          {iniciales(p.name || p.identity)}
                        </span>
                        <span className="truncate text-[13px] text-foreground">
                          {p.name || p.identity}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                </div>
              );
            })
          )}

          {/* Abrirla es cosa del admin, y sólo tiene sentido enseñarlo cuando no
              existe: el resto de la organización no debe ver un botón que le va
              a responder que no. */}
          {!general && puedeAbrirla && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 w-full justify-start text-xs text-muted-foreground"
              onClick={abrirGeneral}
            >
              <Megaphone className="mr-1 size-3.5" /> Open a general room
            </Button>
          )}
        </nav>
      </aside>

      {espacio ? (
        <ChannelView key={espacio.id} spaceId={espacio.id} spaceName={espacio.name} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <MessagesSquare className="mr-2 size-4" /> Nothing to read yet.
        </div>
      )}
    </div>
  );
}
