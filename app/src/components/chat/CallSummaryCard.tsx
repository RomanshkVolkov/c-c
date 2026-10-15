import { useEffect, useState } from "react";
import { PhoneOff, Video } from "lucide-react";

import Markdown from "@/components/markdown/Markdown";
import { api } from "@/lib/api";
import { iniciales } from "@/lib/desde";
import { horaCorta } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import type { APIResponse } from "@/types/auth";

export interface CallSession {
  id: string;
  spaceId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  participants: { identity: string; name: string; guest: boolean; firstJoinedAt: string }[];
  recordingId?: string;
}

/** «45 s», «12 min», «1 h 05 min»: lo mismo que `domain.CallLength`. */
export function callLength(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  const m = Math.floor((ms + 30_000) / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/**
 * El resumen de una llamada terminada, en el canal: cuánto duró, quién estuvo
 * y, si se grabó, la grabación. Lo escribe el servidor al vaciarse la sala
 * (`domain.CallSummary`); esto lo pinta a partir de su `cac:call/<id>`.
 *
 * Mientras carga, o si no carga, se ve la línea de texto del servidor: es la
 * misma información en una frase, y es lo que ve una app de antes.
 *
 * Se vuelve a pedir cuando cambia el cuerpo (quien lo monta le pone el cuerpo
 * de `key`): la grabación lista reescribe la línea, y la tarjeta tiene que
 * enseñarla.
 */
export default function CallSummaryCard({
  sessionId,
  body,
  onOpenRecording,
  onInternalLink,
}: {
  sessionId: string;
  body: string;
  onOpenRecording: () => void;
  onInternalLink: (href: string) => boolean;
}) {
  const { t } = useT();
  const [call, setCall] = useState<CallSession | null>(null);

  useEffect(() => {
    let vivo = true;
    api
      .get<APIResponse<CallSession>>(`/api/v1/call-sessions/${sessionId}`, true)
      // Sólo una llamada de verdad: otra cosa (un backend de antes) deja la frase.
      .then((r) => vivo && setCall(r?.data?.id && Array.isArray(r.data.participants) ? r.data : null))
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [sessionId]);

  if (!call) return <Markdown onInternalLink={onInternalLink}>{body}</Markdown>;

  const gente = call.participants;
  const largo = callLength(call.durationMs);
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card/60 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <PhoneOff className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{t("chat:callEnded")}</span>
        <span className="text-xs text-muted-foreground">
          {[largo, call.endedAt ? `${horaCorta(call.startedAt)}–${horaCorta(call.endedAt)}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {gente.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex -space-x-1.5">
            {gente.slice(0, 6).map((p) => (
              <span
                key={p.identity}
                title={p.guest ? t("chat:callGuest", { name: p.name }) : p.name}
                className="grid size-6 place-items-center rounded-full border-2 border-card bg-muted text-[10px] font-bold"
              >
                {iniciales(p.name)}
              </span>
            ))}
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {t("chat:callPeople", { count: gente.length, names: gente.map((p) => p.name).join(", ") })}
          </span>
        </div>
      )}
      {call.recordingId && (
        <button
          type="button"
          onClick={onOpenRecording}
          className="flex w-fit items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          <Video className="size-3.5" />
          {t("chat:callWatchRecording")}
        </button>
      )}
    </div>
  );
}
