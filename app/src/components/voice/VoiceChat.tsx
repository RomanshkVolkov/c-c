import { useT } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import { iniciales } from "@/lib/desde";
import { useChatStore } from "@/store/chat.store";
import { cn } from "@/lib/utils";

/**
 * El hilo del canal, dentro de la llamada.
 *
 * **No es un chat aparte**, y esa es la decisión que lo define: lo que se
 * escribe aquí sale en `#canal` y lo lee quien no está en la sala. Un chat
 * propio de la llamada habría partido la conversación en dos —una mitad que
 * sobrevive y otra que se evapora al colgar— y nadie sabría dónde buscar
 * después.
 *
 * Con la sala ocupando la pantalla el hilo no se ve, así que compartir un
 * enlace obligaba a minimizar, escribir y volver. Eso es todo lo que esto
 * resuelve.
 *
 * Deliberadamente **más pobre que el canal de verdad**: sin markdown, sin
 * adjuntos, sin editar ni retirar. Aquí se pasa un enlace o una frase mientras
 * alguien habla; para lo demás está el canal, a un clic de Minimize. Meter el
 * editor entero en 340 px sería arrastrar una superficie que nadie va a usar
 * con una llamada en curso.
 */
export default function VoiceChat({
  spaceId,
  spaceName,
  onClose,
}: {
  spaceId: string;
  spaceName: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const messages = useChatStore((s) => s.messages);
  const cargando = useChatStore((s) => s.loading);
  const abierto = useChatStore((s) => s.spaceId);
  const fetch = useChatStore((s) => s.fetch);
  const post = useChatStore((s) => s.post);

  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const fondo = useRef<HTMLDivElement>(null);

  // Sólo si el hilo cargado es otro. Estando en el canal ya suele estar puesto
  // —`ChannelView` lo pidió al entrar— y volver a pedirlo por abrir el panel
  // sería una petición por cada vez que se pulsa el botón.
  useEffect(() => {
    if (abierto !== spaceId) void fetch(spaceId);
  }, [abierto, spaceId, fetch]);

  // Al fondo con cada mensaje: en una llamada lo que importa es lo último, y
  // aquí no cabe el historial de todos modos.
  useEffect(() => {
    fondo.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const enviar = async () => {
    const cuerpo = texto.trim();
    if (!cuerpo || enviando) return;
    setEnviando(true);
    try {
      await post(spaceId, cuerpo);
      setTexto("");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <aside className="flex w-85 shrink-0 flex-col overflow-hidden rounded-xl border bg-card/95 backdrop-blur">
      <header className="flex h-11 shrink-0 items-center border-b px-3">
        <span className="text-[13px] font-semibold">{t("common:last.channelChat")}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common:last.hideChat")}
          className="ml-auto grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-[15px]" />
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {cargando && messages.length === 0 ? (
          <p className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </p>
        ) : messages.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nothing in #{spaceName} yet.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="flex gap-2">
              <span className="grid size-6.5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-bold">
                {iniciales(m.authorName)}
              </span>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{m.authorName}</span>{" "}
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
                {/* En texto plano a propósito: ver el comentario de arriba. */}
                <div className="whitespace-pre-wrap break-words text-[13px]">{m.body}</div>
              </div>
            </div>
          ))
        )}
        <div ref={fondo} />
      </div>

      <div className="shrink-0 border-t p-2">
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void enviar();
            }
          }}
          placeholder={`Message #${spaceName}`}
          className={cn(
            "w-full rounded-md border bg-background px-2.5 py-1.5 text-[13px]",
            "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>
    </aside>
  );
}
