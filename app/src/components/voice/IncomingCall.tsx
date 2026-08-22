import { useEffect } from "react";
import { PhoneOff, Volume2 } from "lucide-react";
import { iniciales } from "@/lib/desde";
import { tonoEntrante } from "@/components/voice/ringtone";
import { useVoice } from "@/store/voice.store";

/**
 * Te están llamando.
 *
 * Encima de todo y con el fondo emborronado, que es lo único que se hace en
 * toda la app: una llamada caduca en veinte segundos y no admite «luego la
 * miro». Un aviso discreto en una esquina es un aviso que se pierde, y perderlo
 * significa que la otra persona se queda hablando sola.
 *
 * Monta una sola vez, en el layout: la llamada puede llegar mientras miras un
 * servidor o una nota, no sólo estando en un canal.
 */
export default function IncomingCall() {
  const entrante = useVoice((s) => s.entrante);
  const sordo = useVoice((s) => s.sordo);
  const aceptar = useVoice((s) => s.aceptarEntrante);
  const rechazar = useVoice((s) => s.rechazarEntrante);
  const ocupacion = useVoice((s) => s.ocupacion);

  // El tono suena mientras la tarjeta esté, y **respeta la sordera**: alguien
  // que se ha puesto sordo en una llamada ha pedido que el ordenador se calle,
  // y sonarle igual es no haberle hecho caso.
  const suena = !!entrante && !sordo;
  useEffect(() => {
    if (!suena) return;
    const tono = tonoEntrante();
    return () => tono.parar();
  }, [suena]);

  if (!entrante) return null;

  const dentro = ocupacion[entrante.spaceId]?.length ?? 0;

  return (
    <div className="fixed inset-0 z-100 grid place-items-center bg-background/70 backdrop-blur-[3px]">
      <div className="w-90 rounded-xl border bg-card p-6 text-center shadow-2xl">
        <span className="relative mx-auto grid size-18 place-items-center rounded-full bg-accent text-xl font-bold text-accent-foreground">
          {/* Dos anillos desfasados: uno solo se lee como un borde, y dos
              haciendo la ola se leen como algo que está pasando ahora. */}
          <span className="absolute inset-0 animate-ping rounded-full border-2 border-success/50" />
          <span
            className="absolute inset-0 animate-ping rounded-full border-2 border-success/30"
            style={{ animationDelay: "0.7s" }}
          />
          {iniciales(entrante.from.name)}
        </span>

        <p className="mt-4 text-[17px] font-semibold">{entrante.from.name}</p>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-[13px] text-muted-foreground">
          <Volume2 className="size-3.5 text-success" />
          Calling you to #{entrante.spaceName}
          {dentro > 0 && ` · ${dentro} in voice`}
        </p>

        <div className="mt-5 flex gap-2.5">
          <button
            onClick={() => void rechazar()}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 text-sm font-semibold text-destructive"
          >
            <PhoneOff className="size-4" /> Decline
          </button>
          <button
            onClick={() => void aceptar()}
            className="h-10 flex-1 rounded-lg bg-success text-sm font-bold text-background"
          >
            Join
          </button>
        </div>
      </div>
    </div>
  );
}
