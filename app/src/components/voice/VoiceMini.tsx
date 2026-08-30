import { useT } from "@/lib/i18n";
import { useNavigate } from "react-router-dom";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useTasksStore } from "@/store/tasks.store";
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
  const abrirEscenario = useVoice((s) => s.abrirEscenario);
  const alternarMic = useVoice((s) => s.alternarMic);
  const salir = useVoice((s) => s.salir);
  const nombre = useTasksStore((s) => s.tree.find((e) => e.id === spaceId)?.name);

  if (!spaceId || estado === "fuera") return null;

  const volver = () => {
    abrirEscenario();
    navigate(`/chat?space=${spaceId}`);
  };

  // Con el sidebar plegado no cabe la caja, pero desaparecer no es una opción:
  // esto es lo único que te dice que tienes el micrófono abierto, y plegar el
  // sidebar es justo lo que hace quien va a olvidarse. Queda el punto verde.
  if (compacto) {
    return (
      <button
        onClick={volver}
        title={`Voice connected · ${nombre ?? "back to the call"}`}
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
          <span className="block text-xs text-muted-foreground">
            {estado === "entrando" ? t("common:servers.connecting") : t("common:servers.voiceConnected")}
          </span>
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
