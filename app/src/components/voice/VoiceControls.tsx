import { useT } from "@/lib/i18n";
import type { LucideIcon } from "lucide-react";
import {
  HeadphoneOff,
  LifeBuoy,
  Headphones,
  Mic,
  MicOff,
  Circle,
  MonitorUp,
  MoreHorizontal,
  PhoneOff,
  Square,
  SlidersHorizontal,
  Video,
  VideoOff,
} from "lucide-react";
import { useState } from "react";

import VoiceReportDialog from "@/components/voice/VoiceReportDialog";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

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
  iconClassName,
  toggles,
}: {
  icon: LucideIcon;
  /** El panel que abre (ver `useDismiss`): pulsarlo no cuenta como «fuera». */
  toggles?: string;
  label: string;
  /** Para rellenar un icono de trazo. Ver el botón de grabar. */
  iconClassName?: string;
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
      data-toggles={toggles}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active ?? false}
      title={label}
      className={cn(
        "motion-press grid size-11.5 place-items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? tone === "danger"
            ? "border-destructive bg-destructive/10 text-destructive"
            : "border-primary bg-primary/15 text-primary"
          : "border-border bg-card text-foreground hover:bg-accent",
      )}
    >
      <Icon className={cn("size-5", iconClassName, spinning && "animate-spin")} />
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
  recording,
  onRecord,
  recordingInFlight,
  canReport = true,
}: {
  mic: boolean;
  deafened: boolean;
  cam: boolean;
  sharing: boolean;
  /** Si ya se está recording. Lo dice el motor, no este botón. */
  recording?: boolean;
  /** Ausente = esta instalación no graba, y entonces el botón no se pinta. */
  onRecord?: () => void;
  recordingInFlight?: boolean;
  onMic: () => void;
  onDeafen: () => void;
  onCam?: () => void;
  onShare?: () => void;
  onSettings?: () => void;
  onLeave: () => void;
  /** El botón de reportar el audio. Sólo donde hay un registro que mandar. */
  canReport?: boolean;
}) {
  const { t } = useT();
  const [reportando, setReportando] = useState(false);
  const mobile = useIsMobile();

  // En el teléfono no caben ocho botones redondos: se cortaban por los dos
  // lados y el de colgar se salía (jose, 18-oct-2026). Quedan los de siempre
  // —micrófono, cámara, audio— y lo demás en «⋯», como en FaceTime. Colgar,
  // rojo y redondo, sin texto.
  if (mobile) {
    const more = [
      onShare && {
        icon: MonitorUp,
        label: sharing ? t("common:voice.stopSharing") : t("common:voice.share"),
        onClick: onShare,
      },
      onSettings && { icon: SlidersHorizontal, label: t("common:voice.settings"), onClick: onSettings },
      onRecord && {
        icon: recording ? Square : Circle,
        label: recording ? t("recordings:stop") : t("recordings:record"),
        onClick: onRecord,
        disabled: recordingInFlight,
      },
      canReport && { icon: LifeBuoy, label: t("common:voice.reportAudio"), onClick: () => setReportando(true) },
    ].filter(Boolean) as { icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean }[];
    return (
      <div className="flex h-21 shrink-0 items-center justify-center gap-3 border-t bg-sidebar pb-[env(safe-area-inset-bottom)]">
        <Round
          icon={mic ? Mic : MicOff}
          label={mic ? t("common:voice.mute") : t("common:voice.unmute")}
          active={!mic}
          onClick={onMic}
        />
        <Round
          icon={cam ? Video : VideoOff}
          label={cam ? t("common:voice.cameraOff") : t("common:voice.cameraOn")}
          tone="primary"
          active={cam}
          onClick={onCam}
          disabled={!onCam}
        />
        <Round
          icon={deafened ? HeadphoneOff : Headphones}
          label={deafened ? t("common:voice.undeafen") : t("common:voice.deafen")}
          active={deafened}
          onClick={onDeafen}
        />
        {more.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("common:voice.more")}
              title={t("common:voice.more")}
              className={cn(
                "motion-press grid size-11.5 place-items-center rounded-full border bg-card text-foreground",
                (sharing || recording) && "border-primary bg-primary/15 text-primary",
              )}
            >
              <MoreHorizontal className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center" className="w-56">
              {more.map((m) => (
                <DropdownMenuItem key={m.label} onClick={m.onClick} disabled={m.disabled}>
                  <m.icon className="size-4" /> {m.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {canReport && <VoiceReportDialog open={reportando} onOpenChange={setReportando} />}
        <button
          type="button"
          onClick={onLeave}
          aria-label={t("common:voice.leave")}
          title={t("common:voice.leave")}
          className="motion-press grid size-11.5 place-items-center rounded-full bg-destructive text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PhoneOff className="size-5" />
        </button>
      </div>
    );
  }

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
        <Round icon={SlidersHorizontal} label={t("common:voice.settings")} onClick={onSettings} toggles="device-settings" />
      )}
      {/* Grabar, por el mismo criterio que compartir pantalla: **no se pinta
          hasta que haga algo**. Si el servidor no tiene grabación montada, un
          botón apagado ahí es un botón que no responde.

          Y cambia de icono —círculo a cuadrado— y no sólo de color, como todos
          los de esta barra. */}
      {onRecord && (
        <Round
          icon={recording ? Square : Circle}
          // **Rellenos, no de trazo.** El símbolo de grabar es un punto sólido
          // y el de parar un cuadrado sólido; en trazo, el aro vacío se lee
          // como «apagado» justo cuando significa lo contrario. Los iconos de
          // lucide vienen en trazo, así que se rellenan aquí.
          iconClassName={recording ? "fill-current" : "fill-current size-4"}
          label={recording ? t("recordings:stop") : t("recordings:record")}
          active={recording}
          spinning={recordingInFlight}
          onClick={onRecord}
          disabled={recordingInFlight}
        />
      )}
      {/* El botón de reportar va **entre los controles y el de colgar**, no
          escondido en un menú: si alguien tiene que buscarlo, no lo pulsa. */}
      {canReport && (
        <>
          <Round
            icon={LifeBuoy}
            label={t("common:voice.reportAudio")}
            tone="primary"
            active={reportando}
            onClick={() => setReportando(true)}
          />
          <VoiceReportDialog open={reportando} onOpenChange={setReportando} />
        </>
      )}

      <span className="mx-1.5 h-7 w-px bg-border" />

      <button
        type="button"
        onClick={onLeave}
        aria-label={t("common:voice.leave")}
        title={t("common:voice.leave")}
        className={cn(
          "motion-press flex h-11.5 items-center gap-2 rounded-full bg-destructive px-5 text-sm font-bold text-background",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <PhoneOff className="size-5" /> {t("common:voice.leaveShort")}
      </button>
    </div>
  );
}
