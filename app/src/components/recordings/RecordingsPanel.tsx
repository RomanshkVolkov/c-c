import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  urlDelMedia,
  useRecordings,
  type Recording,
  type RecordingStatus,
} from "@/store/recordings.store";

/**
 * Lo que se grabó en este canal.
 *
 * Dos decisiones que no se ven y se notan:
 *
 *   - **`<audio>` para una llamada sin pantalla.** Un `<video>` con una pista
 *     de sólo audio pinta un rectángulo negro, que parece un vídeo roto. Lo
 *     decide `finalContentType`, que el servidor ya sabe porque es quien montó
 *     el fichero.
 *   - **El `src` va siempre al proxy de cac**, nunca al bucket. Una URL firmada
 *     que se escapa de una pantalla sigue valiendo hasta que caduca, y esto es
 *     una reunión entera.
 */

type ClaveDeEstado =
  | "statusRecording"
  | "statusFinalizing"
  | "statusReady"
  | "statusPartial"
  | "statusFailed";

const ETIQUETA: Record<RecordingStatus, ClaveDeEstado> = {
  recording: "statusRecording",
  finalizing: "statusFinalizing",
  ready: "statusReady",
  partial: "statusPartial",
  failed: "statusFailed",
};

function duracion(ms?: number): string {
  if (!ms) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Fila({ rec, spaceId }: { rec: Recording; spaceId: string }) {
  const { t } = useT();
  const borrar = useRecordings((s) => s.borrar);
  const [borrando, setBorrando] = useState(false);
  // Sólo se puede ver lo que ya está montado. `partial` también: hay vídeo, y
  // esconderlo por haber perdido una pista sería tirar lo que sí se salvó.
  const verse = rec.status === "ready" || rec.status === "partial";
  const esAudio = (rec.finalContentType ?? "").startsWith("audio/");

  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "text-xs font-semibold",
            rec.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {t(`recordings:${ETIQUETA[rec.status]}`)}
        </span>
        {rec.durationMs ? (
          <span className="text-xs text-muted-foreground">· {duracion(rec.durationMs)}</span>
        ) : null}
        {rec.startedByName && (
          <span className="truncate text-xs text-muted-foreground">
            · {t("recordings:by", { name: rec.startedByName })}
          </span>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("recordings:delete")}
          disabled={borrando}
          onClick={() => {
            // Se pregunta: borrar se lleva el vídeo **y todas las pistas**, y
            // de eso no se vuelve.
            if (!window.confirm(t("recordings:deleteConfirm"))) return;
            setBorrando(true);
            void borrar(rec.id, spaceId).finally(() => setBorrando(false));
          }}
        >
          {borrando ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      </div>

      {/* Por qué está a medias, dicho donde se ve. Una etiqueta que dice
          «parcial» y no explica qué falta deja a quien la lee sin saber si
          puede fiarse de lo que oye. */}
      {rec.status === "partial" && (
        <p className="text-xs text-muted-foreground">{t("recordings:statusPartialWhy")}</p>
      )}

      {verse &&
        (esAudio ? (
          <audio controls preload="metadata" className="w-full" src={urlDelMedia(rec.id)} />
        ) : (
          <video controls preload="metadata" className="w-full rounded" src={urlDelMedia(rec.id)} />
        ))}
    </li>
  );
}

export default function RecordingsPanel({ spaceId }: { spaceId: string }) {
  const { t } = useT();
  const lista = useRecordings((s) => s.lista[spaceId]);
  const cargando = useRecordings((s) => s.cargando[spaceId]);
  const cargar = useRecordings((s) => s.cargar);

  useEffect(() => {
    void cargar(spaceId);
  }, [spaceId, cargar]);

  if (cargando && !lista) {
    return (
      <div className="flex justify-center p-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!lista?.length) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">{t("recordings:panelEmpty")}</p>
    );
  }

  return (
    <ul className="space-y-2 p-3">
      {lista.map((rec) => (
        <Fila key={rec.id} rec={rec} spaceId={spaceId} />
      ))}
    </ul>
  );
}
