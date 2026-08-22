import { useEffect, useState } from "react";
import { PhoneOff, RotateCcw, X } from "lucide-react";
import { iniciales } from "@/lib/desde";
import { tonoSaliente } from "@/components/voice/ringtone";
import { useVoice } from "@/store/voice.store";

/**
 * «Llamando a Elena», encima de la barra de mandos.
 *
 * En su propia fila y no flotando sobre los mosaicos: lo que hay debajo es la
 * gente que ya está en la sala, y taparla para decir que falta alguien es
 * quitar de la vista justo lo que sigue pasando.
 *
 * Cuando se rinde no desaparece. Una fila que se esfuma sola no distingue «no
 * contestó» de «el botón nunca hizo nada», y esa duda acaba en un segundo
 * timbre a alguien que ya dijo que no.
 */
export default function RingRow() {
  const llamando = useVoice((s) => s.llamando);
  const cancelar = useVoice((s) => s.cancelarTimbre);
  const timbrar = useVoice((s) => s.timbrar);
  const sordo = useVoice((s) => s.sordo);

  // El tono sólo mientras espera respuesta, y no cuando ya se rindió: seguir
  // sonando sobre un «no contestó» es un despiste con altavoz.
  const suena = !!llamando && !llamando.sinRespuesta && !sordo;
  useEffect(() => {
    if (!suena) return;
    const tono = tonoSaliente();
    return () => tono.parar();
  }, [suena]);

  // El contador se lleva aquí y no en el store: es un segundero, y un store que
  // cambia una vez por segundo repinta cosas que no tienen nada que ver.
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    if (!llamando || llamando.sinRespuesta) return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [llamando]);

  if (!llamando) return null;

  const seg = Math.max(0, Math.floor((ahora - llamando.desde) / 1000));
  const reloj = `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, "0")}`;

  return (
    <div className="flex shrink-0 items-center gap-3 border-t bg-sidebar px-5 py-2.5">
      <span
        className={cnAnillo(llamando.sinRespuesta)}
        aria-hidden
      >
        {iniciales(llamando.name)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold">
          {llamando.sinRespuesta ? llamando.name : `Ringing ${llamando.name}`}
        </span>
        <span className="block text-xs text-muted-foreground">
          {llamando.sinRespuesta ? "did not answer" : `Calling · ${reloj}`}
        </span>
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {llamando.sinRespuesta ? (
          <>
            <button
              onClick={() => void timbrar(llamando.identity, llamando.name)}
              className="flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-xs hover:bg-accent"
            >
              <RotateCcw className="size-3.5" /> Ring again
            </button>
            <button
              onClick={() => void cancelar()}
              aria-label="Dismiss"
              className="grid size-8 place-items-center rounded-md border bg-card text-muted-foreground hover:bg-accent"
            >
              <X className="size-3.5" />
            </button>
          </>
        ) : (
          <button
            onClick={() => void cancelar()}
            className="flex h-8 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 text-xs font-semibold text-destructive"
          >
            <PhoneOff className="size-3.5" /> Cancel
          </button>
        )}
      </span>
    </div>
  );
}

/** El anillo late mientras suena y se apaga cuando se rinde. */
function cnAnillo(rendido: boolean) {
  return [
    "grid size-9 shrink-0 place-items-center rounded-full bg-accent text-xs font-bold text-accent-foreground",
    rendido ? "opacity-50" : "animate-pulse ring-2 ring-success",
  ].join(" ");
}
