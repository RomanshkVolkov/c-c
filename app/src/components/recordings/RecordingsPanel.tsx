import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  mediaUrl,
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

type StatusKey =
  | "statusRecording"
  | "statusFinalizing"
  | "statusReady"
  | "statusPartial"
  | "statusFailed";

const STATUS_KEY: Record<RecordingStatus, StatusKey> = {
  recording: "statusRecording",
  finalizing: "statusFinalizing",
  ready: "statusReady",
  partial: "statusPartial",
  failed: "statusFailed",
};

function duration(ms?: number): string {
  if (!ms) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Row({ rec, spaceId }: { rec: Recording; spaceId: string }) {
  const { t } = useT();
  const remove = useRecordings((s) => s.remove);
  const confirm = useConfirm();
  const [removing, setBorrando] = useState(false);
  // Sólo se puede ver lo que ya está montado. `partial` también: hay vídeo, y
  // esconderlo por haber perdido una pista sería tirar lo que sí se salvó.
  const playable = rec.status === "ready" || rec.status === "partial";
  const isAudio = (rec.finalContentType ?? "").startsWith("audio/");

  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "text-xs font-semibold",
            rec.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {t(`recordings:${STATUS_KEY[rec.status]}`)}
        </span>
        {rec.durationMs ? (
          <span className="text-xs text-muted-foreground">· {duration(rec.durationMs)}</span>
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
          disabled={removing}
          onClick={() => {
            // Se pregunta: remove se lleva el vídeo **y todas las pistas**, y
            // de eso no se vuelve.
            //
            // Con `useConfirm` y no con `window.confirm`: el diálogo del
            // navegador **no es fiable en el webview de Tauri** —está escrito
            // en `ConfirmDialog.tsx`, y yo lo había usado igual—. Ahí el
            // borrado se habría quedado sin preguntar o sin ejecutarse, según
            // la plataforma.
            void (async () => {
              const ok = await confirm({
                title: t("recordings:deleteConfirm"),
                confirmText: t("recordings:delete"),
                destructive: true,
              });
              if (!ok) return;
              setBorrando(true);
              void remove(rec.id, spaceId).finally(() => setBorrando(false));
            })();
          }}
        >
          {removing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      </div>

      {/* Por qué está a medias, dicho donde se ve. Una etiqueta que dice
          «parcial» y no explica qué falta deja a quien la lee sin saber si
          puede fiarse de lo que oye. */}
      {rec.status === "partial" && (
        <p className="text-xs text-muted-foreground">{t("recordings:statusPartialWhy")}</p>
      )}

      {playable &&
        (isAudio ? (
          <audio controls preload="metadata" className="w-full" src={mediaUrl(rec.id)} />
        ) : (
          <video controls preload="metadata" className="w-full rounded" src={mediaUrl(rec.id)} />
        ))}
    </li>
  );
}

export default function RecordingsPanel({ spaceId }: { spaceId: string }) {
  const { t } = useT();
  const bySpace = useRecordings((s) => s.bySpace[spaceId]);
  const loading = useRecordings((s) => s.loading[spaceId]);
  const load = useRecordings((s) => s.load);

  useEffect(() => {
    void load(spaceId);
  }, [spaceId, load]);

  if (loading && !bySpace) {
    return (
      <div className="flex justify-center p-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!bySpace?.length) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">{t("recordings:panelEmpty")}</p>
    );
  }

  return (
    <ul className="space-y-2 p-3">
      {bySpace.map((rec) => (
        <Row key={rec.id} rec={rec} spaceId={spaceId} />
      ))}
    </ul>
  );
}
