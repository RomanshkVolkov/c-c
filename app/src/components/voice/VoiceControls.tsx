import { useT } from "@/lib/i18n";
import type { LucideIcon } from "lucide-react";
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  SlidersHorizontal,
  Video,
  VideoOff,
} from "lucide-react";
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
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
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
      <Icon className="size-5" />
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
