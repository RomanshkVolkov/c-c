import { useEffect, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ReactionPicker, Reactions } from "@/components/chat/Reactions";
import { LinkifiedText } from "@/components/voice/VoiceChat";
import { iniciales } from "@/lib/desde";
import { horaCorta } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth.store";
import { useCallChat, type GuestChatPass } from "@/store/call-chat.store";

/** Cada cuánto pregunta el invitado, que no tiene avisos en vivo. */
const GUEST_POLL_MS = 3000;

/**
 * El chat de **la llamada**: la pestaña «Llamada» del panel. Lo escrito aquí
 * se queda con la llamada —se lee después desde su resumen en el canal— y no
 * sale en el canal. Ver `VoiceChat` para el porqué de las dos pestañas.
 *
 * Igual de pobre que el del canal, y por lo mismo: texto plano con enlaces que
 * se pulsan. Lo tuyo se retira mientras dura la llamada; al terminar, el chat
 * queda tal cual.
 */
export default function CallChat({ sessionId, guest }: { sessionId?: string | null; guest?: GuestChatPass | null }) {
  const { t } = useT();
  const messages = useCallChat((s) => s.messages);
  const loading = useCallChat((s) => s.loading);
  const load = useCallChat((s) => s.load);
  const loadAsGuest = useCallChat((s) => s.loadAsGuest);
  const react = useCallChat((s) => s.react);
  const post = useCallChat((s) => s.post);
  const withdraw = useCallChat((s) => s.withdraw);
  const myId = useAuthStore((s) => s.session?.id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  // Un miembro pide el chat al abrirlo y luego lo trae el aviso en vivo. El
  // invitado no tiene avisos: pregunta cada pocos segundos **mientras está
  // dentro**, y deja de preguntar al salir (al desmontarse el panel).
  const guestToken = guest?.token;
  const guestPass = guest?.pass;
  useEffect(() => {
    if (sessionId) {
      void load(sessionId).catch(() => {});
      return;
    }
    if (!guestToken || !guestPass) return;
    const pass = { token: guestToken, pass: guestPass };
    void loadAsGuest(pass).catch(() => {});
    const timer = window.setInterval(() => void loadAsGuest(pass).catch(() => {}), GUEST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, guestToken, guestPass, load, loadAsGuest]);
  // Reaccionar es de los miembros (v1): el invitado las ve.
  const canReact = !!sessionId;

  // Al fondo con cada mensaje: en una llamada lo que importa es lo último.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await post(body);
      setDraft("");
    } catch (e) {
      // Lo escrito se queda en la caja: perderlo por un parpadeo de la red es
      // peor que el fallo.
      toast.error(String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div data-thread className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {loading && messages.length === 0 ? (
          <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {t("chat:loading")}
          </p>
        ) : messages.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{t("chat:callChatEmpty")}</p>
        ) : (
          messages.map((m) => {
            const mine = !!myId && m.authorUserId === myId;
            return (
              <div key={m.id} data-msg-id={m.id} className="group relative flex gap-2">
                <span className="grid size-6.5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-bold">
                  {iniciales(m.authorName)}
                </span>
                <div className="min-w-0 flex-1 pr-5">
                  <div className="text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{m.authorName}</span> {horaCorta(m.createdAt)}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[13px]">
                    <LinkifiedText text={m.body} />
                  </div>
                  <Reactions
                    reactions={m.reactions}
                    readOnly={!canReact}
                    onReact={(emoji, on) => react(m.id, emoji, on)}
                  />
                </div>
                {canReact && (
                  <ReactionPicker
                    reactions={m.reactions}
                    onReact={(emoji, on) => react(m.id, emoji, on).catch(() => toast.error(t("chat:reactFailed")))}
                    className={cn(
                      "absolute top-0 rounded p-0.5 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100",
                      mine ? "right-5" : "right-0",
                    )}
                  />
                )}
                {mine && (
                  <button
                    type="button"
                    aria-label={t("chat:withdraw")}
                    title={t("chat:withdraw")}
                    onClick={() => void withdraw(m.id).catch((e) => toast.error(String(e)))}
                    className="absolute right-0 top-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })
        )}
        <div ref={bottom} />
      </div>
      <div className="shrink-0 border-t p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={t("chat:callChatPlaceholder")}
          className={cn(
            "w-full rounded-md border bg-background px-2.5 py-1.5 text-[13px]",
            "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>
    </>
  );
}
