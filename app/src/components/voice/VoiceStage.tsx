import { Loader2, Minimize2, Volume2 } from "lucide-react";
import VoiceControls from "@/components/voice/VoiceControls";
import VoiceTile from "@/components/voice/VoiceTile";
import { useVoice } from "@/store/voice.store";

/**
 * La sala, a pantalla completa.
 *
 * Hasta ahora la llamada era una pastilla en la cabecera del canal: cabían un
 * contador y dos iconos, y nada más. Eso bastaba para hablar, pero no para lo
 * que viene detrás —caras y pantallas compartidas—, que necesita sitio de
 * verdad. Así que la conversación hablada pasa a tener pantalla propia.
 *
 * Lo importante es que **esta pantalla no es la llamada**: minimizarla no
 * cuelga. Por eso el store lleva dos estados y no uno (ver `voice.store.ts`).
 */
export default function VoiceStage({ spaceName }: { spaceName: string }) {
  const estado = useVoice((s) => s.estado);
  const gente = useVoice((s) => s.gente);
  const hablando = useVoice((s) => s.hablando);
  const yo = useVoice((s) => s.yo);
  const mic = useVoice((s) => s.mic);
  const sordo = useVoice((s) => s.sordo);
  const salir = useVoice((s) => s.salir);
  const alternarMic = useVoice((s) => s.alternarMic);
  const alternarSordera = useVoice((s) => s.alternarSordera);
  const cerrarEscenario = useVoice((s) => s.cerrarEscenario);

  // Tú cuentas como presente aunque el motor sólo reporte a los demás.
  const dentro = [...(yo ? [{ identity: yo, name: "You" }] : []), ...gente];
  const solo = dentro.length === 1;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar">
      <header className="flex h-13 shrink-0 items-center gap-3 border-b px-4">
        <Volume2 className="size-4 shrink-0 text-success" />
        <span className="truncate text-sm font-semibold">#{spaceName}</span>
        {/* Sin latencia: el motor todavía no la reporta y un número inventado
            en el sitio donde se mira cuando la llamada va mal es peor que no
            poner nada. Cuando el SDK la dé, va aquí. */}
        <span className="shrink-0 text-[13px] text-muted-foreground">
          {estado === "entrando"
            ? "connecting…"
            : solo
              ? "nobody else yet"
              : `${dentro.length} in voice`}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={cerrarEscenario}
          title="Back to the channel — you stay connected"
          className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent"
        >
          <Minimize2 className="size-[15px]" /> Minimize
        </button>
      </header>

      <div className="min-h-0 flex-1 p-5">
        {estado === "entrando" ? (
          <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Joining #{spaceName}…
          </div>
        ) : (
          <div className="grid size-full auto-rows-fr grid-cols-2 gap-3.5">
            {dentro.map((p) => (
              <VoiceTile
                key={p.identity}
                nombre={p.name || p.identity}
                hablando={hablando.includes(p.identity)}
                // Sólo se sabe del propio: el motor aún no reporta el mute de
                // los demás. Pintar a todos como abiertos sería mentir menos
                // que pintarlos silenciados, así que se calla de los demás.
                silenciado={p.identity === yo && !mic}
              />
            ))}
          </div>
        )}
      </div>

      <VoiceControls
        mic={mic}
        sordo={sordo}
        cam={false}
        compartiendo={false}
        onMic={() => void alternarMic()}
        onSordera={() => void alternarSordera()}
        onSalir={() => void salir()}
      />
    </div>
  );
}
