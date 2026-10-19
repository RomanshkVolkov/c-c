import { useDismiss } from "@/hooks/use-dismiss";
import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { engine } from "@/lib/voice-engine";
import { AudioLines, Check, Loader2, Mic, Video } from "lucide-react";
import { useAudioPrefs } from "@/store/audio-prefs.store";
import { cn } from "@/lib/utils";
import MicLevel from "@/components/voice/MicLevel";

/**
 * Elegir micrófono y cámara sin salirse de la llamada.
 *
 * Existe porque el sistema se equivoca a menudo — en Linux con PipeWire, casi
 * siempre que hay más de una entrada— y sin esto no había forma de corregirlo
 * desde dentro: la app cogía el que dijera el sistema y no había más que
 * hablar. Estuvo pintado y apagado una versión, que es peor que no estar: un
 * botón deshabilitado se lee como «existe y está apagado».
 *
 * **La salida todavía no.** Cambiarla obliga a reconstruir el stream de
 * reproducción de cada pista remota a la vez, y es la que menos se equivoca.
 * Se hará; mientras tanto no se pinta, por la misma razón de arriba.
 */

interface Dispositivo {
  id: string;
  name: string;
  current: boolean;
}

export default function DeviceSettings({
  closing,
  onClose,
}: { closing?: boolean; onClose?: () => void } = {}) {
  const { t } = useT();
  // Se cierra pulsando fuera o con Escape, no sólo con su botón.
  const panel = useDismiss<HTMLDivElement>(!closing, () => onClose?.(), "device-settings");
  const [lista, setLista] = useState<{ mics: Dispositivo[]; cams: Dispositivo[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cambiando, setCambiando] = useState<string | null>(null);

  // Se pregunta al abrir y no al entrar a la sala: enchufar unos auriculares en
  // mitad de una llamada es justo cuando alguien abre esto, y una lista
  // cacheada al entrar no los tendría.
  const cargar = () => {
    engine
      .listDevices()
      .then((d) => {
        setLista(d);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(cargar, []);

  const elegir = async (kind: "mic" | "cam", d: Dispositivo) => {
    setCambiando(d.id);
    try {
      await engine.setDevice(kind, d.id);
      cargar();
    } catch (e) {
      setError(String(e));
    } finally {
      setCambiando(null);
    }
  };

  return (
    <div ref={panel} data-closing={closing || undefined} className="motion-pop-in absolute bottom-24 left-1/2 z-50 w-72 [--pop-origin:bottom_center] -translate-x-1/2 rounded-lg border bg-popover p-1 shadow-lg">
      {error && (
        <p className="px-3 py-2 text-xs text-destructive">{error}</p>
      )}
      {!lista && !error && (
        <p className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Looking for devices…
        </p>
      )}
      {lista && (
        <>
          <Grupo
            icono={Mic}
            titulo={t("common:last.microphone")}
            vacio={t("common:last.noMicrophone")}
            /* Encima de la lista y fuera de ella: lo primero que se quiere saber
               al abrir esto es si entra algo; cuál elegir es la pregunta
               siguiente, y sólo si la respuesta es no.
               Aparte de `children` porque `Grupo` los cuenta para decidir si
               enseña «no hay ninguno» — con el medidor dentro, ese aviso no
               saldría nunca— y porque un `div` dentro de un `ul` no es HTML. */
            encabezado={<MicLevel />}
          >
            {lista.mics.map((d) => (
              <Fila
                key={d.id}
                d={d}
                ocupado={cambiando === d.id}
                onClick={() => void elegir("mic", d)}
              />
            ))}
          </Grupo>
          <SupresionRuido onError={setError} />
          <Grupo icono={Video} titulo={t("common:last.camera")} vacio={t("common:last.noCamera")}>
            {lista.cams.map((d) => (
              <Fila
                key={d.id}
                d={d}
                ocupado={cambiando === d.id}
                onClick={() => void elegir("cam", d)}
              />
            ))}
          </Grupo>
        </>
      )}
    </div>
  );
}

/**
 * El interruptor de la supresión de ruido. Encendido, la voz sale limpia de
 * ventilador y teclado; apagado sale tal cual, que es lo que se quiere para
 * música o un instrumento. Se recuerda (`useAudioPrefs`) y se aplica en caliente.
 */
function SupresionRuido({ onError }: { onError: (e: string) => void }) {
  const { t } = useT();
  const on = useAudioPrefs((s) => s.noiseSuppression);
  const guardar = useAudioPrefs((s) => s.setNoiseSuppression);
  const cambiar = async () => {
    guardar(!on);
    try {
      await engine.setNoiseSuppression(!on);
    } catch (e) {
      onError(String(e));
    }
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => void cambiar()}
      className="flex w-full items-start gap-2 rounded px-3 py-2 text-left text-xs hover:bg-accent"
    >
      <AudioLines className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-foreground">{t("common:last.noiseSuppression")}</span>
        <span className="block text-muted-foreground">{t("common:last.noiseSuppressionHint")}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
          on ? "justify-end bg-primary" : "justify-start bg-muted-foreground/30",
        )}
      >
        <span className="size-3 rounded-full bg-background" />
      </span>
    </button>
  );
}

function Grupo({
  icono: Icono,
  titulo,
  vacio,
  encabezado,
  children,
}: {
  icono: typeof Mic;
  titulo: string;
  vacio: string;
  encabezado?: React.ReactNode;
  children: React.ReactNode[];
}) {
  return (
    <div className="py-1">
      <p className="flex items-center gap-1.5 px-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Icono className="size-3" /> {titulo}
      </p>
      {encabezado}
      {/* «No hay ninguna» dicho con palabras. Una sección vacía sin más se lee
          como que la app no terminó de cargar. */}
      {children.length === 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">{vacio}</p>
      ) : (
        <ul>{children}</ul>
      )}
    </div>
  );
}

function Fila({
  d,
  ocupado,
  onClick,
}: {
  d: Dispositivo;
  ocupado: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onClick}
        disabled={ocupado || d.current}
        aria-current={d.current}
        className={cn(
          "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-[13px]",
          d.current ? "text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <span className="w-3.5 shrink-0">
          {ocupado ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : d.current ? (
            <Check className="size-3.5 text-success" />
          ) : null}
        </span>
        <span className="min-w-0 truncate">{d.name}</span>
      </button>
    </li>
  );
}
