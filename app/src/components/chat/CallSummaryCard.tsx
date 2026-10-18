import { useEffect, useState } from "react";
import { MessageSquare, PhoneOff, Video } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LinkifiedText } from "@/components/voice/VoiceChat";
import { fetchCallMessages, type CallMessage } from "@/store/call-chat.store";

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
  /** Cuántos mensajes tiene su chat. */
  messages?: number;
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
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<APIResponse<CallSession>>(`/api/v1/call-sessions/${sessionId}`, true)
      // Sólo una llamada de verdad: otra cosa (un backend de antes) deja la frase.
      .then((r) => alive && setCall(r?.data?.id && Array.isArray(r.data.participants) ? r.data : null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (!call) return <Markdown onInternalLink={onInternalLink}>{body}</Markdown>;

  const people = call.participants;
  const length = callLength(call.durationMs);
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card/60 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <PhoneOff className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{t("chat:callEnded")}</span>
        <span className="text-xs text-muted-foreground">
          {[length, call.endedAt ? `${horaCorta(call.startedAt)}–${horaCorta(call.endedAt)}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {people.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex -space-x-1.5">
            {people.slice(0, 6).map((p) => (
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
            {t("chat:callPeople", { count: people.length, names: people.map((p) => p.name).join(", ") })}
          </span>
        </div>
      )}
      {(call.recordingId || (call.messages ?? 0) > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {call.recordingId && (
            <button
              type="button"
              onClick={onOpenRecording}
              className="motion-press flex w-fit items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              <Video className="size-3.5" />
              {t("chat:callWatchRecording")}
            </button>
          )}
          {(call.messages ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => setViewing(true)}
              className="motion-press flex w-fit items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              <MessageSquare className="size-3.5" />
              {t("chat:viewCallChat", { count: call.messages })}
            </button>
          )}
        </div>
      )}
      {viewing && <CallChatViewer sessionId={call.id} onClose={() => setViewing(false)} />}
    </div>
  );
}

/**
 * «Ver chat»: lo que se escribió en una llamada terminada, de sólo lectura.
 * Se pide al abrirlo, no con la tarjeta: la mayoría de los resúmenes no se
 * abren nunca.
 */
export function CallChatViewer({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useT();
  const [messages, setMessages] = useState<CallMessage[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchCallMessages(sessionId)
      .then((m) => alive && setMessages(m))
      .catch(() => alive && setMessages([]));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("chat:callChatTitle")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {messages === null ? (
            <p className="text-xs text-muted-foreground">{t("chat:loading")}</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className="flex gap-2">
                <span className="grid size-6.5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-bold">
                  {iniciales(m.authorName)}
                </span>
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{m.authorName}</span> {horaCorta(m.createdAt)}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[13px]">
                    <LinkifiedText text={m.body} />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
