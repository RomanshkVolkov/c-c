import { useT } from "@/lib/i18n";
import { useNavigate } from "react-router-dom";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useTasksStore } from "@/store/tasks.store";
import { useOrgsStore } from "@/store/orgs.store";
import { goInOrg } from "@/lib/ir-en-org";
import RecChip from "@/components/voice/RecChip";
import { useRecordingNotice } from "@/components/voice/useRecordingNotice";
import { useVoice } from "@/store/voice.store";
import { cn } from "@/lib/utils";

/**
 * «Sigues en la llamada», al pie del sidebar.
 *
 * Existe porque minimizar ya no cuelga: sin un recordatorio permanente se puede
 * pasar la tarde en un tablero con el micrófono abierto y sin saberlo. Está en
 * el sidebar y no en la cabecera del canal a propósito — la cabecera sólo se ve
 * desde el canal, que es justo el único sitio donde ya sabías que estabas.
 *
 * Y trae mute: al que se le olvida que está conectado es al que le hace falta
 * silenciarse sin buscar dónde.
 */
export default function VoiceMini({ compacto }: { compacto?: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  const spaceId = useVoice((s) => s.spaceId);
  const estado = useVoice((s) => s.estado);
  const mic = useVoice((s) => s.mic);
  const recording = useVoice((s) => s.recording);
  // `?? []` y no `gente.find` a secas: quien graba puede no estar en la lista
  // —se fue de la llamada y la grabación sigue— y el chip tiene que aguantarlo
  // sin nombre en vez de reventar la barra entera.
  const gente = useVoice((s) => s.gente);
  const recorderName = (gente ?? []).find((p) => p.identity === recording?.by)?.name;
  // El aviso para quien tiene la llamada minimizada. En el escenario ya hay una
  // franja que lo dice —`RecordingBanner`—, y este hook se calla cuando está
  // abierto: el mismo hecho anunciado dos veces se lee como dos grabaciones.
  useRecordingNotice(recorderName);
  const abrirEscenario = useVoice((s) => s.abrirEscenario);
  const alternarMic = useVoice((s) => s.alternarMic);
  const salir = useVoice((s) => s.salir);
  // El nombre del canal lo trae la llamada, no el árbol: la llamada sigue al
  // cambiar de org, y entonces el árbol es el de otra y no sabe cómo se llama.
  // El árbol queda de respaldo para una llamada que no lo trajo.
  const nombreDeLaLlamada = useVoice((s) => s.spaceName);
  const nombreEnElArbol = useTasksStore((s) => s.tree.find((e) => e.id === spaceId)?.name);
  // Una reunión con invitados no es un canal: se llama por su título.
  const meetId = useVoice((s) => s.meetId);
  const titulo = useVoice((s) => s.title);
  const nombre = meetId ? titulo : (nombreDeLaLlamada ?? nombreEnElArbol);
  // Y de qué org es, cuando no es la de la pantalla: «general» a secas no dice
  // a cuál de tus dos clientes estás hablando.
  const orgDeLaLlamada = useVoice((s) => s.orgId);
  const otraOrg = useOrgsStore((s) =>
    orgDeLaLlamada && orgDeLaLlamada !== s.currentOrgId
      ? (s.orgs.find((o) => o.id === orgDeLaLlamada)?.name ?? null)
      : null,
  );

  if ((!spaceId && !meetId) || estado === "fuera") return null;

  // Volver es volver **a su org**, no al canal del mismo id en la que tengas
  // delante — que no existe, y caía en su general.
  const volver = () => {
    abrirEscenario();
    // La reunión tiene su propia pantalla; el canal, la suya.
    if (meetId) navigate(`/call/${meetId}`);
    else goInOrg(navigate, `/chat?space=${spaceId}`, orgDeLaLlamada);
  };

  // Con el sidebar plegado no cabe la caja, pero desaparecer no es una opción:
  // esto es lo único que te dice que tienes el micrófono abierto, y plegar el
  // sidebar es justo lo que hace quien va a olvidarse. Queda el punto verde.
  if (compacto) {
    return (
      <button
        onClick={volver}
        title={`Voice connected · ${nombre ?? "back to the call"}${otraOrg ? ` · ${otraOrg}` : ""}`}
        aria-label={t("common:servers.backToCall")}
        className="mx-auto my-1 grid size-8 place-items-center rounded-lg border border-success/35 bg-success/[.07]"
      >
        <span className="size-2 rounded-full bg-success" />
      </button>
    );
  }

  return (
    <div className="m-2 flex flex-col gap-2 rounded-lg border border-success/35 bg-success/[.07] p-2 px-2.5">
      <button
        onClick={volver}
        title={t("common:servers.backToCall")}
        className="flex min-w-0 items-center gap-2 text-left"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-success" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-success">
            {nombre ?? t("common:servers.voice")}
          </span>
          {otraOrg && (
            <span className="block truncate text-xs text-foreground/80">
              {t("common:servers.inOrg", { org: otraOrg })}
            </span>
          )}
          <span className="block text-xs text-muted-foreground">
            {estado === "entrando" ? t("common:servers.connecting") : t("common:servers.voiceConnected")}
          </span>
          {/* Aquí también, y no sólo en el escenario: quien minimiza la llamada
              y sigue hablando tiene que seguir viendo que se le graba. */}
          {recording && <RecChip className="mt-1" by={recorderName} />}
        </span>
      </button>
      <div className="flex gap-1.5">
        <button
          onClick={() => void alternarMic()}
          aria-pressed={!mic}
          className={cn(
            "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border bg-card text-xs",
            !mic && "border-destructive/40 text-destructive",
          )}
        >
          {mic ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
          {mic ? t("common:servers.mute") : t("common:servers.unmute")}
        </button>
        <button
          onClick={() => void salir()}
          title={t("common:servers.disconnect")}
          aria-label={t("common:servers.disconnect")}
          className="grid h-7 w-8.5 place-items-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive"
        >
          <PhoneOff className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
