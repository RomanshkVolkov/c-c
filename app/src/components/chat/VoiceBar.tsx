import { useT } from "@/lib/i18n";
import { Loader2, Mic, MicOff, Volume2 } from "lucide-react";
import { iniciales } from "@/lib/desde";
import { cn } from "@/lib/utils";
import { useVoice } from "@/store/voice.store";

/**
 * Entrar a la voz de este canal, o volver a la llamada que ya tienes abierta.
 *
 * Vive en la cabecera, al lado del nombre: la conversación hablada es del
 * canal, no una pantalla aparte a la que haya que ir. Lo que **no** hace es ser
 * la llamada entera —eso es ahora `VoiceStage`—; aquí sólo está la puerta.
 */
export default function VoiceBar({ spaceId }: { spaceId: string }) {
  const { t } = useT();
  const enSala = useVoice((s) => s.spaceId);
  const estado = useVoice((s) => s.estado);
  const mic = useVoice((s) => s.mic);
  const error = useVoice((s) => s.error);
  const errorSpaceId = useVoice((s) => s.errorSpaceId);
  const ocupacion = useVoice((s) => s.ocupacion);
  const entrar = useVoice((s) => s.entrar);
  const abrirEscenario = useVoice((s) => s.abrirEscenario);
  const alternarMic = useVoice((s) => s.alternarMic);

  const aqui = enSala === spaceId && estado !== "fuera";

  if (aqui) {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <button
          onClick={abrirEscenario}
          title={t("common:last.backToCall")}
          className="flex h-8 items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3.5 text-[13px] font-semibold text-success"
        >
          <span className="size-1.5 rounded-full bg-success" /> Back to call
        </button>
        {/* Silenciarse sin volver al escenario: es lo único que se pide con
            prisa desde fuera de la llamada, y hacerlo pasar por dos clics es
            justo el retraso que hace que te oigan. */}
        <button
          onClick={() => void alternarMic()}
          title={mic ? t("common:last.mute") : t("common:last.unmute")}
          aria-pressed={!mic}
          className={cn(
            "grid size-8 place-items-center rounded-lg border bg-card hover:bg-accent",
            !mic && "border-destructive/40 text-destructive",
          )}
        >
          {mic ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
        </button>
      </span>
    );
  }

  // Quién anda dentro sin que tú estés. Es lo que rompe el círculo del canal
  // vacío: las caras en el botón son el motivo para pulsarlo.
  const dentro = ocupacion[spaceId] ?? [];
  // Sólo el error de **este** canal. `error` es uno para toda la sala, y sin
  // este filtro un fallo de la cámara en otra llamada pintaba de rojo el botón
  // de entrar de todos los canales, con un texto que aquí no dice nada.
  const fallo = errorSpaceId === spaceId ? error : null;

  return (
    <button
      onClick={() => void entrar(spaceId)}
      disabled={estado === "entrando"}
      title={fallo ?? t("common:last.joinVoiceChannel")}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-lg border pl-2 pr-3 text-[13px] font-semibold",
        fallo
          ? "border-destructive/40 text-destructive"
          : dentro.length > 0
            ? "border-success/40 bg-success/10 text-success"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {estado === "entrando" ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : dentro.length > 0 ? (
        <span className="flex items-center">
          {dentro.slice(0, 3).map((p, i) => (
            <span
              key={p.identity}
              title={p.name || p.identity}
              className={cn(
                "grid size-5 place-items-center rounded-full bg-accent text-[10px] font-bold text-accent-foreground",
                i > 0 && "-ml-1.5 border border-background",
              )}
            >
              {iniciales(p.name || p.identity)}
            </span>
          ))}
        </span>
      ) : (
        <Volume2 className="size-3.5" />
      )}
      {t("common:last.joinVoice")}
    </button>
  );
}
