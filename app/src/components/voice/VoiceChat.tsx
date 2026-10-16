import { horaCorta } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { CornerUpLeft, Loader2 } from "lucide-react";

import { iniciales } from "@/lib/desde";
import { useChatStore, type ChatMessage } from "@/store/chat.store";
import { useAuthStore } from "@/store/auth.store";
import { ReplyingBar, ReplyQuote } from "@/components/chat/ReplyQuote";
import { cn } from "@/lib/utils";
import { linkify } from "@/lib/linkify";
import { openInternalRef } from "@/lib/open-ref";
import { openExternal } from "@/lib/platform";

/**
 * El hilo del canal, dentro de la llamada: la pestaña «Canal» del panel de la
 * llamada (`CallChatPanel`).
 *
 * Hasta el 15-oct-2026 era **el único chat** de la llamada, y a propósito: un
 * chat propio partiría la conversación en dos —una mitad que sobrevive y otra
 * que se evapora al colgar—. Lo que cambió es lo segundo: el chat de la
 * llamada ya **no se evapora**. Se guarda con la llamada, se consulta desde su
 * resumen en el canal, y es el único sitio donde pueden escribir los invitados,
 * que no ven el canal. Así que ahora hay dos pestañas, y cada una dice dónde
 * queda lo escrito: «Llamada» (`CallChat`) o «Canal» (esto).
 *
 * Deliberadamente **más pobre que el canal de verdad**: sin markdown, sin
 * adjuntos, sin editar ni retirar. Aquí se pasa un enlace o una frase mientras
 * alguien habla; para lo demás está el canal, a un clic de Minimize. Meter el
 * editor entero en 340 px sería arrastrar una superficie que nadie va a usar
 * con una llamada en curso.
 */
export default function VoiceChat({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const { t } = useT();
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const openSpaceId = useChatStore((s) => s.spaceId);
  const fetch = useChatStore((s) => s.fetch);
  const post = useChatStore((s) => s.post);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Responder también aquí: «¿esto lo dices por lo que puso Bea?» es de las
  // cosas que más se preguntan con una llamada en curso.
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const myId = useAuthStore((s) => s.session?.id);
  const bottom = useRef<HTMLDivElement>(null);

  // Sólo si el hilo cargado es otro. Estando en el canal ya suele estar puesto
  // —`ChannelView` lo pidió al entrar— y volver a pedirlo por abrir el panel
  // sería una petición por cada vez que se pulsa el botón.
  useEffect(() => {
    if (openSpaceId !== spaceId) void fetch(spaceId);
  }, [openSpaceId, spaceId, fetch]);

  // Al fondo con cada mensaje: en una llamada lo que importa es lo último, y
  // aquí no cabe el historial de todos modos.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await post(spaceId, body, replyingTo?.id);
      setDraft("");
      setReplyingTo(null);
    } finally {
      setSending(false);
    }
  };

  return (
    <>

      {/* `min-h-0`, que es lo que faltaba.
          
          Un elemento flex se niega a encogerse por debajo de su contenido, así
          que sin esto la lista no desbordaba: crecía, la columna crecía con
          ella, y el `overflow-hidden` del `aside` **se comía el compositor**.
          
          Y explica lo otro: `scrollIntoView` desplaza el ancestro que sí
          desborda, así que al no desbordar ésta movía otra cosa. De ahí que
          apareciera scroll donde no tocaba en cuanto el chat crecía. */}
      <div data-thread className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {loading && messages.length === 0 ? (
          <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {t("chat:loading")}
          </p>
        ) : messages.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t("chat:emptyChannel", { name: spaceName })}
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} data-msg-id={m.id} className="group relative flex gap-2">
              <span className="grid size-6.5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-bold">
                {iniciales(m.authorName)}
              </span>
              <div className="min-w-0 flex-1 pr-5">
                <div className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{m.authorName}</span>{" "}
                  {horaCorta(m.createdAt)}
                </div>
                {m.replyTo && <ReplyQuote quote={m.replyTo} className="mt-0.5" />}
                {/* En texto plano a propósito: ver el comentario de arriba. */}
                <div className="whitespace-pre-wrap break-words text-[13px]">
                  <LinkifiedText text={m.body} />
                </div>
              </div>
              {m.kind !== "system" && (
                <button
                  type="button"
                  aria-label={t("chat:reply")}
                  title={t("chat:reply")}
                  onClick={() => {
                    setReplyingTo(m);
                    inputRef.current?.focus();
                  }}
                  className="absolute right-0 top-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                >
                  <CornerUpLeft className="size-3.5" />
                </button>
              )}
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>

      <div className="shrink-0 border-t p-2">
        {replyingTo && (
          <ReplyingBar
            authorName={replyingTo.authorUserId === myId ? t("chat:you") : replyingTo.authorName}
            body={replyingTo.body}
            onCancel={() => setReplyingTo(null)}
          />
        )}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message #${spaceName}`}
          className={cn(
            "w-full rounded-md border bg-background px-2.5 py-1.5 text-[13px]",
            "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>
    </>
  );
}

/**
 * El cuerpo de un mensaje, con sus URLs como enlaces. Sigue siendo texto
 * plano: sólo se reconocen `http://` y `https://`. Un enlace de cac (tarea, documento)
 * se abre dentro de la app; los demás, en el navegador.
 */
export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, i) =>
        part.kind === "text" ? (
          part.text
        ) : (
          <a
            key={i}
            href={part.href}
            className="text-primary underline underline-offset-2 hover:opacity-80"
            onClick={(e) => {
              e.preventDefault();
              if (!openInternalRef(part.href)) void openExternal(part.href);
            }}
          >
            {part.href}
          </a>
        ),
      )}
    </>
  );
}
