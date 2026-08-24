import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarClock, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { tonoEntrante } from "@/components/voice/ringtone";
import { horaDual } from "@/lib/horas";
import { useMeetingsStore } from "@/store/meetings.store";
import { useVoice } from "@/store/voice.store";

/**
 * Empieza una reunión.
 *
 * Hermana de `IncomingCall` y **no la misma**, aunque se parezcan: aquélla está
 * cosida a la semántica de una llamada —aceptar descuelga, rechazar avisa a
 * quien llamaba, y caduca en veinte segundos porque alguien está esperando al
 * otro lado—. Una reunión no tiene a quien llama ni rechazo que comunicar:
 * cerrarla no le dice nada a nadie, dura un minuto, y lo que ofrece no es
 * «contestar» sino «entrar». Generalizar una en la otra habría dejado un
 * componente lleno de condicionales para no repetir un fondo emborronado.
 *
 * Monta una sola vez en el layout: la reunión llega mientras miras cualquier
 * cosa, que es justo lo que la hace útil.
 */
export default function MeetingCall() {
  const entrante = useMeetingsStore((s) => s.entrante);
  const descartar = useMeetingsStore((s) => s.descartar);
  const sordo = useVoice((s) => s.sordo);
  const entrarEnSala = useVoice((s) => s.entrar);
  const navigate = useNavigate();

  // Suena mientras la tarjeta esté, y respeta la sordera: quien se ha puesto
  // sordo ha pedido que el ordenador se calle, y sonarle igual porque «esto es
  // otra cosa» es no haberle hecho caso.
  const suena = !!entrante && !sordo;
  useEffect(() => {
    if (!suena) return;
    const tono = tonoEntrante();
    return () => tono.parar();
  }, [suena]);

  if (!entrante) return null;

  const { alla, aqui, mismaZona } = horaDual(entrante.firesAt, entrante.timezone);

  const entrar = async () => {
    const sala = entrante.spaceId;
    descartar();
    if (!sala) return;
    navigate(`/chat?space=${sala}`);
    try {
      await entrarEnSala(sala);
    } catch {
      // El canal queda abierto igual: llegar a la sala y entrar a la llamada
      // son dos cosas, y fallar la segunda no puede dejarte en ninguna parte.
    }
  };

  return (
    <div className="fixed inset-0 z-100 grid place-items-center bg-background/70 backdrop-blur-[3px]">
      <div className="w-90 rounded-xl border bg-card p-6 text-center shadow-2xl">
        <span className="relative mx-auto grid size-18 place-items-center rounded-full bg-accent text-accent-foreground">
          <span className="absolute inset-0 animate-ping rounded-full border-2 border-primary/50" />
          <span
            className="absolute inset-0 animate-ping rounded-full border-2 border-primary/30"
            style={{ animationDelay: "0.7s" }}
          />
          <CalendarClock className="size-7" />
        </span>

        <p className="mt-4 text-[17px] font-semibold">{entrante.title}</p>

        {/* La hora en las dos zonas. Quien la creó dijo «las nueve» pensando en
            su reloj; quien la lee está mirando el suyo. */}
        <p className="mt-1 text-[13px] text-muted-foreground">
          Starting now · {alla || aqui}
          {!mismaZona && alla && <span> · {aqui} your time</span>}
        </p>

        {entrante.spaceName && (
          <p className="mt-1 flex items-center justify-center gap-1.5 text-[13px] text-muted-foreground">
            <Volume2 className="size-3.5 text-success" />#{entrante.spaceName}
          </p>
        )}

        <div className="mt-5 flex gap-2.5">
          {/* Sin sala no hay a dónde llevar a nadie, y un botón «entrar» que no
              entra a ningún sitio es peor que no tenerlo. */}
          {entrante.spaceId ? (
            <>
              <Button className="flex-1" onClick={entrar}>
                Join #{entrante.spaceName || "room"}
              </Button>
              <Button variant="ghost" className="flex-1" onClick={descartar}>
                Dismiss
              </Button>
            </>
          ) : (
            <Button className="flex-1" variant="secondary" onClick={descartar}>
              Got it
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
