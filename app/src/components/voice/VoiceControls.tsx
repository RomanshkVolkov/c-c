import { useT } from "@/lib/i18n";
import type { LucideIcon } from "lucide-react";
import {
  HeadphoneOff,
  LifeBuoy,
  Loader2,
  Headphones,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  SlidersHorizontal,
  Video,
  VideoOff,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

/**
 * Los mandos de la llamada.
 *
 * Círculos de 46 px y no una fila de iconos pequeños: son los botones que se
 * pulsan con prisa —alguien entra en la habitación, el perro ladra— y un blanco
 * grande es la diferencia entre silenciarte y no llegar a tiempo.
 *
 * Cada botón cambia de **icono** y no sólo de color al encenderse: el color
 * solo deja fuera a quien no lo distingue, y además un rojo sobre negro se lee
 * igual de «activo» que de «error».
 */

function Round({
  icon: Icon,
  label,
  active,
  tone = "danger",
  onClick,
  disabled,
  spinning,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  /** Gira el icono. Un `Loader2` quieto parece un botón roto, no uno ocupado. */
  spinning?: boolean;
  /** De qué color se enciende: rojo para apagar algo, cian para encenderlo. */
  tone?: "danger" | "primary";
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active ?? false}
      title={label}
      className={cn(
        "grid size-11.5 place-items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? tone === "danger"
            ? "border-destructive bg-destructive/10 text-destructive"
            : "border-primary bg-primary/15 text-primary"
          : "border-border bg-card text-foreground hover:bg-accent",
      )}
    >
      <Icon className={cn("size-5", spinning && "animate-spin")} />
    </button>
  );
}

export default function VoiceControls({
  mic,
  deafened,
  cam,
  sharing,
  onMic,
  onDeafen,
  onCam,
  onShare,
  onSettings,
  onLeave,
}: {
  mic: boolean;
  deafened: boolean;
  cam: boolean;
  sharing: boolean;
  onMic: () => void;
  onDeafen: () => void;
  onCam?: () => void;
  onShare?: () => void;
  onSettings?: () => void;
  onLeave: () => void;
}) {
  const { t } = useT();
  const [reportando, setReportando] = useState(false);

  /**
   * «No se me oye», en una pulsación y desde dentro de la llamada.
   *
   * Aquí y no en un menú de ajustes porque es el único momento en que el motor
   * sabe lo que hace falta —qué micrófono abrió, a qué ritmo, si sube algo y si
   * ese algo trae señal— y porque quien tiene el problema está en una reunión y
   * no va a ir a buscarlo. Sin formulario: una caja de texto delante es una
   * barrera justo cuando menos paciencia hay.
   */
  const reportar = async () => {
    setReportando(true);
    try {
      const { reportarAudio } = await import("@/lib/voice-report");
      const salida = await reportarAudio();
      if (salida === "done") toast.success(t("common:voice.reportFiled"));
      else if (salida === "failed") {
        toast.error(t("common:voice.reportFailed"), {
          description: t("common:voice.reportFailedBody"),
        });
      }
    } finally {
      setReportando(false);
    }
  };
  return (
    <div className="flex h-21 shrink-0 items-center justify-center gap-2.5 border-t bg-sidebar">
      <Round
        icon={mic ? Mic : MicOff}
        label={mic ? t("common:voice.mute") : t("common:voice.unmute")}
        active={!mic}
        onClick={onMic}
      />
      <Round
        icon={deafened ? HeadphoneOff : Headphones}
        label={deafened ? t("common:voice.undeafen") : t("common:voice.deafen")}
        active={deafened}
        onClick={onDeafen}
      />
      <Round
        icon={cam ? Video : VideoOff}
        label={cam ? t("common:voice.cameraOff") : t("common:voice.cameraOn")}
        tone="primary"
        active={cam}
        onClick={onCam}
        disabled={!onCam}
      />
      {/* Compartir pantalla y los ajustes **no se pintan hasta que hagan
          algo**. La primera versión los dejaba apagados con el argumento de
          que así la barra no cambiaba de forma cuando llegaran; en la mano de
          alguien eso son tres botones que no responden, y lo primero que se
          reportó de la v1.6.38 fue justo eso. Una barra que crece luego cuesta
          menos que una que miente ahora. */}
      {onShare && (
        <Round
          icon={MonitorUp}
          label={sharing ? t("common:voice.stopSharing") : t("common:voice.share")}
          tone="primary"
          active={sharing}
          onClick={onShare}
        />
      )}
      {onSettings && (
        <Round icon={SlidersHorizontal} label={t("common:voice.settings")} onClick={onSettings} />
      )}
      {/* El botón de reportar va **entre los controles y el de colgar**, no
          escondido en un menú: si alguien tiene que buscarlo, no lo pulsa. */}
      <Round
        icon={reportando ? Loader2 : LifeBuoy}
        label={t("common:voice.reportAudio")}
        tone="primary"
        spinning={reportando}
        onClick={() => void reportar()}
        disabled={reportando}
      />

      <span className="mx-1.5 h-7 w-px bg-border" />

      <button
        type="button"
        onClick={onLeave}
        aria-label={t("common:voice.leave")}
        title={t("common:voice.leave")}
        className={cn(
          "flex h-11.5 items-center gap-2 rounded-full bg-destructive px-5 text-sm font-bold text-background",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <PhoneOff className="size-5" /> Leave
      </button>
    </div>
  );
}
