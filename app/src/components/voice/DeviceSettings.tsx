import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Loader2, Mic, Video } from "lucide-react";
import { cn } from "@/lib/utils";

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

export default function DeviceSettings() {
  const [lista, setLista] = useState<{ mics: Dispositivo[]; cams: Dispositivo[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cambiando, setCambiando] = useState<string | null>(null);

  // Se pregunta al abrir y no al entrar a la sala: enchufar unos auriculares en
  // mitad de una llamada es justo cuando alguien abre esto, y una lista
  // cacheada al entrar no los tendría.
  const cargar = () => {
    invoke<{ mics: Dispositivo[]; cams: Dispositivo[] }>("voice_list_devices")
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
      await invoke("voice_set_device", { kind, deviceId: d.id });
      cargar();
    } catch (e) {
      setError(String(e));
    } finally {
      setCambiando(null);
    }
  };

  return (
    <div className="absolute bottom-24 left-1/2 z-50 w-72 -translate-x-1/2 rounded-lg border bg-popover p-1 shadow-lg">
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
          <Grupo icono={Mic} titulo="Microphone" vacio="No microphone found">
            {lista.mics.map((d) => (
              <Fila
                key={d.id}
                d={d}
                ocupado={cambiando === d.id}
                onClick={() => void elegir("mic", d)}
              />
            ))}
          </Grupo>
          <Grupo icono={Video} titulo="Camera" vacio="No camera found">
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

function Grupo({
  icono: Icono,
  titulo,
  vacio,
  children,
}: {
  icono: typeof Mic;
  titulo: string;
  vacio: string;
  children: React.ReactNode[];
}) {
  return (
    <div className="py-1">
      <p className="flex items-center gap-1.5 px-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Icono className="size-3" /> {titulo}
      </p>
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
