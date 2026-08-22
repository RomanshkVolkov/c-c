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

function Redondo({
  icono: Icono,
  etiqueta,
  activo,
  tono = "peligro",
  onClick,
  disabled,
}: {
  icono: LucideIcon;
  etiqueta: string;
  activo?: boolean;
  /** De qué color se enciende: rojo para apagar algo, cian para encenderlo. */
  tono?: "peligro" | "primario";
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={etiqueta}
      aria-pressed={activo ?? false}
      title={etiqueta}
      className={cn(
        "grid size-11.5 place-items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-40",
        activo
          ? tono === "peligro"
            ? "border-destructive bg-destructive/10 text-destructive"
            : "border-primary bg-primary/15 text-primary"
          : "border-border bg-card text-foreground hover:bg-accent",
      )}
    >
      <Icono className="size-5" />
    </button>
  );
}

export default function VoiceControls({
  mic,
  sordo,
  cam,
  compartiendo,
  onMic,
  onSordera,
  onCam,
  onCompartir,
  onAjustes,
  onSalir,
}: {
  mic: boolean;
  sordo: boolean;
  cam: boolean;
  compartiendo: boolean;
  onMic: () => void;
  onSordera: () => void;
  onCam?: () => void;
  onCompartir?: () => void;
  onAjustes?: () => void;
  onSalir: () => void;
}) {
  return (
    <div className="flex h-21 shrink-0 items-center justify-center gap-2.5 border-t bg-sidebar">
      <Redondo
        icono={mic ? Mic : MicOff}
        etiqueta={mic ? "Mute your microphone" : "Unmute your microphone"}
        activo={!mic}
        onClick={onMic}
      />
      <Redondo
        icono={sordo ? HeadphoneOff : Headphones}
        etiqueta={sordo ? "Undeafen" : "Deafen — stop hearing and being heard"}
        activo={sordo}
        onClick={onSordera}
      />
      {/* Cámara y pantalla llegan en su propio PR. Se pintan apagados y sin
          respuesta en vez de esconderse: la barra no cambia de forma cuando
          lleguen, y quien la mira ya sabe qué va a haber ahí. */}
      <Redondo
        icono={cam ? Video : VideoOff}
        etiqueta="Camera — coming soon"
        tono="primario"
        activo={cam}
        onClick={onCam}
        disabled={!onCam}
      />
      <Redondo
        icono={MonitorUp}
        etiqueta="Share your screen — coming soon"
        tono="primario"
        activo={compartiendo}
        onClick={onCompartir}
        disabled={!onCompartir}
      />
      <Redondo
        icono={SlidersHorizontal}
        etiqueta="Audio and video settings — coming soon"
        onClick={onAjustes}
        disabled={!onAjustes}
      />

      <span className="mx-1.5 h-7 w-px bg-border" />

      <button
        type="button"
        onClick={onSalir}
        aria-label="Leave the call"
        title="Leave the call"
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
